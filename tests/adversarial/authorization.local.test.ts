// Adversarial suite, authorization side, in-process (m1-hosted-connector
// task 9.2): the token passthrough attempt, which no live test can observe.
// The real MCP app behind its gate (a test authorization server publishing
// the keys), the real worker, PostgreSQL 17 in Docker set up as a preview
// (apps/worker/test/lib/stage-db.ts). A principal whose tool arguments carry
// its own bearer token (as topic, question and request id) gets a normal
// answer; the token never appears in any log line of either service, and
// neither service opens a connection anywhere but the database, the JWKS
// host and the test client (spec connector-authorization "Tokens are never
// forwarded"; participant-simulation "No outbound traffic").
//
// Skipped without Docker unless A2H_DB_PG_REQUIRED=1 (CI's `pnpm test`).
// Run: pnpm --filter @a2h/tests test
import { after, before, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createApp, type LogLine } from "../../apps/mcp/src/app.ts";
import { openDatabase } from "../../apps/mcp/src/db.ts";
import { modernClient } from "../../apps/mcp/test/lib/a2h.ts";
import { startAuthServer, withToken, type TestAuthServer } from "../../apps/mcp/test/lib/auth-server.ts";
import type { WorkerLogLine } from "../../apps/worker/src/log.ts";
import { startWorker, type RunningWorker } from "../../apps/worker/src/worker.ts";
import { addPrincipal, skipWithoutDocker, STAGE, startStageDb, testConfig, testSigningKey, type StageDb } from "../../apps/worker/test/lib/stage-db.ts";

const JW = "sim-jw-9e48"; // prompt persona, opinion, net 600 → gross 750
const PRINCIPAL = "user-passthrough";

describe("adversarial: token passthrough attempt (in-process, Postgres in Docker)", { skip: skipWithoutDocker() }, () => {
  let stage: StageDb;
  let as: TestAuthServer;
  let app: ReturnType<typeof createApp> | undefined;
  let database: ReturnType<typeof openDatabase> | undefined;
  let worker: RunningWorker | undefined;
  const mcpLogs: LogLine[] = [];
  const workerLogs: WorkerLogLine[] = [];
  let url = "";

  before(async () => {
    stage = await startStageDb();
    await stage.admin.query("UPDATE simulated_personas SET delay_seconds = 1");
    await addPrincipal(stage.admin, PRINCIPAL, "verified_organisation");
    as = await startAuthServer();
    // The resource URL must name the port the client will use: reserve one first.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    url = `http://127.0.0.1:${port}/${STAGE}/mcp`;
    database = openDatabase({ connectionString: stage.db.connectionString, schema: stage.db.schema, ssl: false });
    app = createApp({
      stage: STAGE,
      mcpBasePath: `/${STAGE}/mcp`,
      log: (l) => mcpLogs.push(l),
      auth: { required: true, issuer: as.issuer, jwksUrl: as.jwksUrl, resourceUrl: url, pingOpen: false },
      pingMaxConcurrent: 4,
      a2h: { db: database.db, feeRate: 0.2, clearingShare: 0.5, approvalKey: new Uint8Array(32).fill(9), limits: { perMinute: 600, perDay: 20000 } },
    });
    await new Promise<void>((r) => app!.server.listen(port, "127.0.0.1", r));
    worker = await startWorker({ config: testConfig(stage.db, { signing: testSigningKey(`a2h-${STAGE}-passthrough01`) }), log: (l) => workerLogs.push(l), dispatchIntervalMs: 500, pollingIntervalSeconds: 1 });
  });
  after(async () => {
    await worker?.stop().catch(() => undefined);
    await app?.shutdown(1000).catch(() => undefined);
    await database?.close().catch(() => undefined);
    await as?.stop();
    await stage?.stop();
  });

  /** Every outbound connection and every fetch the process makes while the test runs. */
  function watchOutbound(t: TestContext, realFetch: typeof fetch): { connections: string[]; fetches: string[] } {
    const seen = { connections: [] as string[], fetches: [] as string[] };
    const connectOf = Reflect.get(net.Socket.prototype, "connect") as (...a: unknown[]) => net.Socket;
    t.mock.method(net.Socket.prototype, "connect", function (this: net.Socket, ...args: unknown[]) {
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

  test("case A6 (in-process): a tool argument that looks like a token never reaches a log line or an outbound call of the mcp service or the worker", { timeout: 90_000 }, async (t) => {
    const realFetch = globalThis.fetch;
    const token = await as.mint({ sub: PRINCIPAL, aud: url, email: "passthrough@example.org" });
    const outbound = watchOutbound(t, realFetch);
    const question = `Which of these two routes feels safer to cycle at rush hour? Authorization: Bearer ${token}`;
    const client = await modernClient(url, () => ({ action: "accept", content: { question } }), withToken(token, realFetch));
    let id: string;
    try {
      // `topic` is at most 200 characters (packages/protocol tools.ts): the token's tail fits and still looks like one.
      const found = await client.callTool({ name: "find_humans", arguments: { topic: `Bearer ${token.slice(-120)}`, request_type: "opinion" } });
      assert.equal(found.isError, undefined, JSON.stringify(found).slice(0, 300));
      // A token's head is not a request id (A2H-xxxx): refused by the schema, or not_found; never echoed either way.
      const byId = await client.callTool({ name: "check_requests", arguments: { request_id: token.slice(0, 8) } });
      assert.ok(["schema_invalid", "not_found"].includes((byId.structuredContent as { error?: { code?: string } }).error?.code ?? ""), JSON.stringify(byId).slice(0, 300));
      assert.ok(!JSON.stringify(byId).includes(token.slice(0, 8)), "the refusal echoed the token's head");
      const sent = await client.callTool({
        name: "request_human",
        arguments: {
          to: JW,
          intent: "opinion",
          audience: "named_individual",
          time_shape: "one_shot",
          format: "poll",
          question,
          options: [
            { id: "harbourside", label: "Route A along the harbourside" },
            { id: "stokes-croft", label: "Route B through Stokes Croft" },
          ],
          lane: "paid",
          bid_minor: 750,
          currency: "EUR",
          expires_at: new Date(Date.now() + 5 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
          data_terms: { storage: "principal_workspace", attribution: "attributed", training: "off" },
        },
      });
      assert.equal(sent.isError, undefined, JSON.stringify(sent).slice(0, 400));
      id = (sent.structuredContent as { request_id: string }).request_id;
      // The worker delivers, the prompt persona answers within seconds.
      const deadline = Date.now() + 60_000;
      let status = "sent";
      while (status !== "answered" && Date.now() < deadline) {
        await sleep(1_000);
        const r = await client.callTool({ name: "check_requests", arguments: { request_id: id } });
        status = (r.structuredContent as { requests: { status: string }[] }).requests[0]!.status;
      }
      assert.equal(status, "answered", "the simulated participant answered");
      const answered = await client.callTool({ name: "check_requests", arguments: { request_id: id } });
      assert.ok(!JSON.stringify(answered).includes(token.slice(-24)), "the answer carried the token back");
    } finally {
      await client.close();
    }
    t.mock.restoreAll();
    await sleep(100);

    // No log line of either service holds any 8-character piece of the token, nor the email claim.
    const lines = [...mcpLogs.map((l) => JSON.stringify(l)), ...workerLogs.map((l) => JSON.stringify(l))];
    assert.ok(lines.length > 10, "log lines were captured");
    for (let i = 0; i + 8 <= token.length; i += 1) {
      const piece = token.slice(i, i + 8);
      const hit = lines.find((l) => l.includes(piece));
      assert.equal(hit, undefined, `a piece of the token (offset ${i}) is in a log line: ${hit?.slice(0, 160)}`);
    }
    assert.ok(!lines.some((l) => l.includes("passthrough@example.org")), "the token's email claim is in a log line");
    // Outbound: the JWKS fetch only; sockets to the database, the JWKS host and the test client only.
    assert.deepEqual([...new Set(outbound.fetches)], [as.jwksUrl], "the only fetch is the JWKS");
    const dbPort = new URL(stage.db.connectionString).port;
    const allowed = new Set([new URL(url).host, `127.0.0.1:${dbPort}`, `localhost:${dbPort}`, new URL(as.issuer).host]);
    const elsewhere = outbound.connections.filter((c) => !allowed.has(c));
    assert.deepEqual(elsewhere, [], "a connection went somewhere other than the database, the JWKS host and the test client");
  });
});
