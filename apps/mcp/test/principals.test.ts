// m1-hosted-connector tasks 7.2 to 7.4 against Postgres 17 and the test
// authorization server: the principal of every call is the token's account
// (spec connector-authorization "The principal of every tool call is the
// token's subject"; request-approval "Principal recorded", "Principal's own
// policy applies"), the per-principal limits (hosted-endpoint "Minute limit
// reached", "Limit shared across instances"), and what records and logs may
// hold (connector-authorization "Tokens are never forwarded", design D10).
import { after, before, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ProtocolError, type CallToolResult } from "@modelcontextprotocol/client";
import type { DbConfig } from "../src/config.ts";
import type { AuthConfig } from "../src/auth.ts";
import { freshSchema, skipWithoutDocker, sqlIn, startPostgres, writeCounts, type PgContainer } from "./lib/db.ts";
import { TEST_POLICY, callRaw, ensurePrincipalRows, isInputRequired, modernClient, retry, startA2h, texts, type A2hOptions, type RunningA2h } from "./lib/a2h.ts";
import { startAuthServer, TEST_CLIENT_ID, TEST_RESOURCE, withToken, type TestAuthServer } from "./lib/auth-server.ts";
import { BASE, ORIGINAL } from "./lib/fixtures.ts";

const A = { principal_id: "user-a", identity_mode: "verified_organisation", verified: true } as const;
const B = { principal_id: "user-b", identity_mode: "verified_organisation", verified: true } as const;
const ACCEPT = { approval: { action: "accept", content: { question: ORIGINAL } } };
const FIND = { topic: "patient information leaflets", request_type: "judgment" };

function errorOf(r: CallToolResult): { code: string; stage: string; retryable: boolean; details?: { retry_after_seconds: number } } {
  assert.equal(r.isError, true, JSON.stringify(r));
  return (r.structuredContent as { error: { code: string; stage: string; retryable: boolean } }).error;
}

describe("principals, limits and records behind the gate", { skip: skipWithoutDocker() }, () => {
  let pgc: PgContainer;
  let as: TestAuthServer;
  const running: RunningA2h[] = [];

  before(async () => {
    pgc = await startPostgres();
    as = await startAuthServer();
  });
  after(async () => {
    for (const s of running) await s.stop();
    pgc?.stop();
    await as?.stop();
  });

  function gate(): AuthConfig {
    return { required: true, issuer: as.issuer, jwksUrl: as.jwksUrl, resourceUrl: TEST_RESOURCE, pingOpen: false };
  }

  /** A fresh schema with principals A and B (as consent creates them) and a gated server on it. */
  async function fresh(options: A2hOptions = {}, db?: DbConfig): Promise<{ db: DbConfig; server: RunningA2h }> {
    const schema = db ?? (await freshSchema(pgc));
    if (!db) {
      await ensurePrincipalRows(schema, A, TEST_POLICY);
      await ensurePrincipalRows(schema, B, TEST_POLICY);
    }
    const server = await startA2h(schema, { auth: gate(), ensurePrincipal: false, ...options });
    running.push(server);
    return { db: schema, server };
  }

  async function clientFor(url: string, sub: string, claims: Record<string, unknown> = {}, accept = false) {
    const token = await as.mint({ sub, ...claims });
    return modernClient(url, accept ? () => ({ action: "accept", content: { question: ORIGINAL } }) : undefined, withToken(token));
  }

  describe("Requirement: The principal of every tool call is the token's subject", () => {
    test("Scenario: Request created under the signed-in principal (and Principal recorded): another account gets not_found", async () => {
      const { db, server } = await fresh();
      const a = await clientFor(server.url, A.principal_id, {}, true);
      const b = await clientFor(server.url, B.principal_id);
      try {
        const sent = await a.callTool({ name: "request_human", arguments: BASE });
        assert.equal(sent.isError, undefined, JSON.stringify(sent));
        const id = (sent.structuredContent as { request_id: string }).request_id;
        const [row] = await sqlIn<{ principal_id: string }>(db, "SELECT principal_id FROM requests WHERE id = $1", [id]);
        assert.equal(row?.principal_id, A.principal_id);
        // A sees it; B does not, by id or in its list.
        const own = await a.callTool({ name: "check_requests", arguments: { request_id: id } });
        assert.equal(own.isError, undefined, JSON.stringify(own));
        assert.equal(errorOf(await b.callTool({ name: "check_requests", arguments: { request_id: id } })).code, "not_found");
        const list = await b.callTool({ name: "check_requests", arguments: {} });
        assert.deepEqual((list.structuredContent as { requests: unknown[] }).requests, []);
      } finally {
        await a.close();
        await b.close();
      }
    });

    test("Scenario: Approval state used by another account: -32602 invalid_request_state, nothing created", async () => {
      const { db, server } = await fresh();
      const a = await clientFor(server.url, A.principal_id);
      const b = await clientFor(server.url, B.principal_id);
      try {
        const round = await callRaw(a, "request_human", BASE);
        assert.ok(isInputRequired(round), JSON.stringify(round));
        await assert.rejects(retry(b, "request_human", BASE, round.requestState, ACCEPT), (error: unknown) => {
          assert.ok(error instanceof ProtocolError, String(error));
          assert.equal(error.code, -32602);
          assert.equal((error.data as { reason?: string } | undefined)?.reason, "invalid_request_state");
          return true;
        });
        assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
        // The genuine owner can still use it.
        const ok = await retry(a, "request_human", BASE, round.requestState, ACCEPT);
        assert.equal(ok.isError, undefined, JSON.stringify(ok));
      } finally {
        await a.close();
        await b.close();
      }
    });

    test("a token whose account has no principal row: unauthorized, sign in again, nothing written", async () => {
      const { db, server } = await fresh();
      const c = await clientFor(server.url, "user-never-consented");
      try {
        const r = await c.callTool({ name: "find_humans", arguments: FIND });
        const e = errorOf(r);
        assert.equal(e.code, "unauthorized");
        assert.match(texts(r).join(" "), /[Ss]ign in again/);
        assert.equal(errorOf(await c.callTool({ name: "request_human", arguments: BASE })).code, "unauthorized");
        assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
        assert.deepEqual(await sqlIn(db, "SELECT principal_id FROM principals WHERE principal_id = 'user-never-consented'"), [], "the mcp side never creates a principal");
        assert.deepEqual(await sqlIn(db, "SELECT count(*)::int AS n FROM rate_limit_windows"), [{ n: 0 }]);
      } finally {
        await c.close();
      }
    });
  });

  test("Scenario: Principal's own policy applies: same bid, B over its own budget, A within its own", async () => {
    const { db, server } = await fresh();
    await sqlIn(db, "UPDATE principal_policies SET monthly_budget_minor = 1000 WHERE principal_id = $1", [B.principal_id]);
    const a = await clientFor(server.url, A.principal_id);
    const b = await clientFor(server.url, B.principal_id);
    try {
      assert.ok(isInputRequired(await callRaw(a, "request_human", BASE)), "A is asked for approval");
      const refused = (await callRaw(b, "request_human", BASE)) as CallToolResult;
      assert.equal(errorOf(refused).code, "over_budget");
      // A policy change applies to the next call, not after the token expires (design D4).
      await sqlIn(db, "UPDATE principal_policies SET monthly_budget_minor = 50000 WHERE principal_id = $1", [B.principal_id]);
      assert.ok(isInputRequired(await callRaw(b, "request_human", BASE)));
    } finally {
      await a.close();
      await b.close();
    }
  });

  describe("Requirement: Per-principal tool-call limit", () => {
    test("Scenario: Minute limit reached: rate_limited with the seconds to wait; the call creates nothing", async () => {
      const { db, server } = await fresh({ limits: { perMinute: 2, perDay: 2000 } });
      const a = await clientFor(server.url, A.principal_id);
      const b = await clientFor(server.url, B.principal_id);
      try {
        for (let i = 0; i < 2; i++) assert.equal((await a.callTool({ name: "find_humans", arguments: FIND })).isError, undefined);
        const before = await writeCounts(db);
        const over = await a.callTool({ name: "request_human", arguments: BASE });
        const e = errorOf(over);
        assert.deepEqual(
          { code: e.code, stage: e.stage, retryable: e.retryable, details: e.details },
          // NOW is 09:00:00 UTC: the minute window ends 60 s later.
          { code: "rate_limited", stage: "throttle", retryable: true, details: { retry_after_seconds: 60 } },
        );
        assert.match(texts(over).join(" "), /rate_limited/);
        assert.equal(errorOf(await a.callTool({ name: "check_requests", arguments: {} })).code, "rate_limited");
        assert.deepEqual(await writeCounts(db), before, "no request, no event, no blocked row");
        // Another principal is not affected.
        assert.equal((await b.callTool({ name: "find_humans", arguments: FIND })).isError, undefined);
        // Counted in Postgres, one row per window.
        const [row] = await sqlIn<{ count: number }>(db, "SELECT count FROM rate_limit_windows WHERE principal_id = $1 AND window_kind = 'minute'", [A.principal_id]);
        assert.equal(row?.count, 4);
      } finally {
        await a.close();
        await b.close();
      }
    });

    test("the day limit: rate_limited until the UTC day ends", async () => {
      const { server } = await fresh({ limits: { perMinute: 100, perDay: 2 } });
      const a = await clientFor(server.url, A.principal_id);
      try {
        for (let i = 0; i < 2; i++) assert.equal((await a.callTool({ name: "find_humans", arguments: FIND })).isError, undefined);
        const e = errorOf(await a.callTool({ name: "find_humans", arguments: FIND }));
        assert.equal(e.code, "rate_limited");
        assert.deepEqual(e.details, { retry_after_seconds: 15 * 3600 });
      } finally {
        await a.close();
      }
    });

    test("Scenario: Limit shared across instances: two servers on one stage count one sum", async () => {
      const first = await fresh({ limits: { perMinute: 3, perDay: 2000 } });
      const second = await fresh({ limits: { perMinute: 3, perDay: 2000 } }, first.db);
      const one = await clientFor(first.server.url, A.principal_id);
      const two = await clientFor(second.server.url, A.principal_id);
      try {
        for (const c of [one, two, one]) assert.equal((await c.callTool({ name: "find_humans", arguments: FIND })).isError, undefined);
        assert.equal(errorOf(await two.callTool({ name: "find_humans", arguments: FIND })).code, "rate_limited");
      } finally {
        await one.close();
        await two.close();
      }
    });
  });

  describe("Records and logs (design D10)", () => {
    /** Every outbound connection and every fetch the process makes while the test runs. */
    function watchOutbound(t: TestContext, realFetch: typeof fetch): { connections: string[]; fetches: string[] } {
      const seen = { connections: [] as string[], fetches: [] as string[] };
      const connectOf = Reflect.get(net.Socket.prototype, "connect") as (...a: unknown[]) => net.Socket;
      t.mock.method(net.Socket.prototype, "connect", function (this: net.Socket, ...args: unknown[]) {
        // Node normalises net.connect() calls into [[options, callback]].
        const [first, second] = (Array.isArray(args[0]) ? args[0] : args) as [unknown, unknown];
        const target =
          typeof first === "object" && first !== null
            ? `${(first as { host?: string }).host ?? (first as { path?: string }).path ?? "?"}:${(first as { port?: number }).port ?? ""}`
            : `${typeof second === "string" ? second : "localhost"}:${String(first)}`;
        seen.connections.push(target);
        return Reflect.apply(connectOf, this, args);
      });
      t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
        seen.fetches.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return realFetch(input, init);
      });
      return seen;
    }

    test("Scenario: Token absent from records; Tokens are never forwarded (only the JWKS host is reached); log lines carry ids, never the email", async (t) => {
      const realFetch = globalThis.fetch;
      // Its own authorization server: a new origin, so the keys are fetched over a new connection the watcher sees.
      const own = await startAuthServer();
      t.after(() => own.stop());
      const db = await freshSchema(pgc);
      await ensurePrincipalRows(db, A, TEST_POLICY);
      const server = await startA2h(db, { auth: { ...gate(), issuer: own.issuer, jwksUrl: own.jwksUrl }, ensurePrincipal: false });
      running.push(server);
      const outbound = watchOutbound(t, realFetch);
      const token = await own.mint({ sub: A.principal_id, email: "ana.lovelace@example.org", name: "Ana Lovelace" });
      const client = await modernClient(server.url, () => ({ action: "accept", content: { question: ORIGINAL } }), withToken(token, realFetch));
      let id: string;
      try {
        const sent = await client.callTool({ name: "request_human", arguments: BASE });
        id = (sent.structuredContent as { request_id: string }).request_id;
        assert.ok(id);
        await client.callTool({ name: "check_requests", arguments: { request_id: id } });
        await client.callTool({ name: "find_humans", arguments: FIND });
      } finally {
        await client.close();
      }
      t.mock.restoreAll();
      await new Promise((r) => setTimeout(r, 50));

      // Every row of every table of the stage schema, and every log line.
      const tables = await sqlIn<{ table_name: string }>(db, "SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [db.schema]);
      const rows: string[] = [];
      for (const { table_name } of tables) {
        for (const r of await sqlIn<{ j: string }>(db, `SELECT row_to_json(t)::text AS j FROM "${table_name}" t`)) rows.push(r.j);
      }
      assert.ok(rows.length > 10, "rows were read");
      const records = rows.join("\n") + "\n" + server.logs.map((l) => JSON.stringify(l)).join("\n");
      for (let i = 0; i + 8 <= token.length; i++) {
        const piece = token.slice(i, i + 8);
        assert.ok(!records.includes(piece), `an 8-character piece of the token at ${i} appears in a row or log line`);
      }
      assert.ok(!records.includes("ana.lovelace") && !records.includes("Lovelace"), "no email or name from the token");

      // Log lines: the opaque principal id, the client id and the request id.
      const calls = server.logs.filter((l) => l.msg === "tool call");
      // request_human logs both rounds (input_required, then sent), then check_requests and find_humans.
      assert.equal(calls.length, 4);
      for (const l of calls) {
        assert.equal(l.principal_id, A.principal_id);
        assert.equal(l.client_id, TEST_CLIENT_ID);
        assert.equal(typeof l.http_request_id, "string");
      }
      const access = server.logs.filter((l) => l.msg === "request" && l.status === 200);
      assert.ok(access.length > 0 && access.every((l) => l.principal_id === A.principal_id && l.client_id === TEST_CLIENT_ID));

      // Outbound: the server fetched the JWKS and nothing else; sockets went to the test client's server, the database and the JWKS host.
      assert.ok(outbound.fetches.length >= 1, "the keys were fetched");
      assert.deepEqual([...new Set(outbound.fetches)], [own.jwksUrl]);
      const allowed = new Set([new URL(server.url).host, `127.0.0.1:${new URL(db.connectionString).port}`, `localhost:${new URL(db.connectionString).port}`, new URL(own.issuer).host]);
      const elsewhere = outbound.connections.filter((c) => !allowed.has(c));
      assert.deepEqual(elsewhere, [], "connections other than the database, the JWKS host and the test client");
      assert.ok(outbound.connections.includes(new URL(own.issuer).host), `the watcher saw the JWKS connection: ${outbound.connections.join(", ")}`);
    });
  });
});
