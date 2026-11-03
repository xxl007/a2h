// request_human after m2-approval-page (task 3.1): one test per scenario of
// openspec/changes/m2-approval-page/specs/protocol/request-approval/spec.md
// and the request_human parts of protocol/request-lifecycle and
// protocol/schemas, plus the validation scenarios of the m1 spec that still
// hold (validation runs before anything is recorded). Real tools, the
// official client, Postgres 17. Send and Don't send are the approval page's
// (apps/web); here `approveOnPage` calls the same shared `decideApproval`.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ProtocolError, type CallToolResult, type FetchLike } from "@modelcontextprotocol/client";
import { approvalTokenHash, gross, REQUEST_ID_PATTERN, RequestHumanOutputSchema, type RequestHumanOutput } from "@a2h/protocol";
import type { DbConfig } from "../src/config.ts";
import { freshSchema, skipWithoutDocker, sqlIn, startPostgres, writeCounts, type PgContainer } from "./lib/db.ts";
import {
  NOW,
  TEST_PRINCIPAL,
  TEST_WEB_ORIGIN,
  approveOnPage,
  callRaw,
  isInputRequired,
  legacyClient,
  modernClient,
  retry,
  startA2h,
  texts,
  urlClient,
  type A2hOptions,
  type InputRequiredRound,
  type RunningA2h,
} from "./lib/a2h.ts";
import { BASE, EDITED, LABOUR, ORIGINAL, PUSH_POLL, THIRD_PARTY } from "./lib/fixtures.ts";

type Args = Record<string, unknown>;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Flip the high bit of the 6-bit value at the middle of a base64url string: a data bit, never padding. */
function flipMiddle(segment: string): string {
  const i = Math.floor(segment.length / 2);
  const v = BASE64URL.indexOf(segment[i]!);
  assert.ok(v >= 0, "base64url segment");
  return segment.slice(0, i) + BASE64URL[v ^ 0b100000] + segment.slice(i + 1);
}

interface UrlRound extends Omit<InputRequiredRound, "inputRequests"> {
  inputRequests?: Record<string, { method: string; params: { mode?: string; url?: string; message: string } & Record<string, unknown> }>;
}

type Awaiting = RequestHumanOutput & { status: "awaiting_approval"; approval_url: string; approval_expires_at: string };

describe("request_human", { skip: skipWithoutDocker() }, () => {
  let pgc: PgContainer;
  const running: RunningA2h[] = [];

  before(async () => {
    pgc = await startPostgres();
  });
  after(async () => {
    for (const s of running) await s.stop();
    pgc?.stop();
  });

  async function fresh(options: A2hOptions = {}): Promise<{ db: DbConfig; server: RunningA2h }> {
    const db = await freshSchema(pgc);
    const server = await startA2h(db, options);
    running.push(server);
    return { db, server };
  }

  /** request_human from a client without URL elicitation: the awaiting result at once. */
  async function ask(url: string, args: Args = BASE): Promise<CallToolResult> {
    const client = await modernClient(url);
    try {
      return await client.callTool({ name: "request_human", arguments: args });
    } finally {
      await client.close();
    }
  }

  function awaitingOf(result: CallToolResult): Awaiting {
    assert.ok(!result.isError, texts(result).join(" | "));
    const out = RequestHumanOutputSchema.parse(result.structuredContent);
    assert.equal(out.status, "awaiting_approval");
    return out as Awaiting;
  }

  /** Ask, then Send on the page; the request id. */
  async function sendViaPage(db: DbConfig, server: RunningA2h, args: Args = BASE, question?: string): Promise<string> {
    const out = awaitingOf(await ask(server.url, args));
    const decided = await approveOnPage(db, out.approval_url, question === undefined ? {} : { question });
    assert.equal(decided.kind, "sent", JSON.stringify(decided));
    return out.request_id;
  }

  function errorOf(result: CallToolResult): { code: string; stage: string; retryable: boolean; detail?: string } {
    assert.equal(result.isError, true, `expected an error result: ${texts(result).join(" | ")}`);
    return (result.structuredContent as { error: { code: string; stage: string; retryable: boolean; detail?: string } }).error;
  }

  async function rowOf(db: DbConfig, id: string) {
    const [r] = await sqlIn<{ status: string; question: string; agent_draft: string; approval_token_hash: string; not_sent_reason: string | null }>(
      db,
      "SELECT status, question, agent_draft, approval_token_hash, not_sent_reason FROM requests WHERE id = $1",
      [id],
    );
    return r!;
  }

  async function deliveries(db: DbConfig): Promise<number> {
    const [r] = await sqlIn<{ n: number }>(db, "SELECT count(*)::int AS n FROM request_deliveries");
    return r!.n;
  }

  // ---- Manifest validation runs before anything is recorded ----------------

  test("Scenario: Bid below reserve: outside_participant_rules, nothing recorded, reserve not stated", async () => {
    const { db, server } = await fresh();
    const reserve = gross(2500, 0.2); // 3125
    const result = await ask(server.url, { ...BASE, bid_minor: reserve - 1 });
    const error = errorOf(result);
    assert.equal(error.code, "outside_participant_rules");
    assert.equal(error.stage, "rules");
    const everything = JSON.stringify(result);
    for (const leak of ["3125", "31.25", "2500", "25.00", "reserve"]) assert.ok(!everything.toLowerCase().includes(leak), `detail leaks ${leak}`);
    const counts = await writeCounts(db);
    assert.equal(counts["requests"], 0);
    assert.equal(counts["request_events"], 0);
    assert.equal(counts["blocked_manifests"], 1, "the block is counted for the participant");
  });

  for (const [name, question, code] of [
    ["Push-poll", PUSH_POLL, "forbidden_content"],
    ["Third-party personal data", THIRD_PARTY, "forbidden_content"],
    ["Labour disguised as a question", LABOUR, "forbidden_content"],
  ] as const) {
    test(`Scenario: ${name}: ${code} at stage content, nothing recorded`, async () => {
      const { db, server } = await fresh();
      const result = await ask(server.url, { ...BASE, question });
      const error = errorOf(result);
      assert.equal(error.code, code);
      assert.equal(error.stage, "content");
      assert.ok(!JSON.stringify(result).includes(question), "the question is not echoed");
      assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
    });
  }

  test("Scenario: Quiet hours: deferred delivery when the expiry allows (decided on Send), retryable refusal when it does not", async () => {
    // sim-ep-5c07: quiet 22:00-07:00 Europe/London, latency promise 24 h, judgment net 2000 (gross 2500).
    const late = new Date("2026-10-27T23:00:00Z");
    const { db, server } = await fresh({ now: () => late });
    const args = { ...BASE, to: "sim-ep-5c07", bid_minor: 2600, expires_at: "2026-10-30T12:00:00+00:00" };
    const out = awaitingOf(await ask(server.url, args));
    const decided = await approveOnPage(db, out.approval_url, { now: late });
    assert.equal(decided.kind, "sent");
    if (decided.kind === "sent") {
      assert.equal(decided.deferred, true);
      assert.equal(new Date(decided.deliver_at).toISOString(), "2026-10-28T07:00:00.000Z");
    }
    const tooSoon = await ask(server.url, { ...args, expires_at: "2026-10-28T20:00:00+00:00" });
    const error = errorOf(tooSoon);
    assert.equal(error.code, "outside_participant_rules");
    assert.equal(error.retryable, true);
    assert.equal((await writeCounts(db))["requests"], 1);
  });

  test("Scenario: Interruption budget exceeded: outside_participant_rules and the block is counted; requests awaiting approval take no interruption", async () => {
    // sim-bk-2e6f accepts at most 2 interruptions a day; estimate net 3500 (gross 4375).
    const { db, server } = await fresh();
    const args = { ...BASE, to: "sim-bk-2e6f", intent: "estimate", question: "How many days does road freight from Lyon to Rotterdam take this month?", bid_minor: 4400 };
    for (let i = 0; i < 3; i++) awaitingOf(await ask(server.url, args));
    for (let i = 0; i < 2; i++) await sendViaPage(db, server, args);
    const third = await ask(server.url, args);
    assert.equal(errorOf(third).code, "outside_participant_rules");
    const blocked = await sqlIn<{ code: string }>(db, "SELECT code FROM blocked_manifests");
    assert.deepEqual(blocked.map((b) => b.code), ["interruption_budget"]);
  });

  test("The approval link needs 15 minutes before the latency promise: a shorter one gets the latency refusal; the silent persona (5-minute promise) takes a 20-minute expiry", async () => {
    const { db, server } = await fresh();
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
    const short = await ask(server.url, { ...BASE, to: "sim-hb-1f7d", bid_minor: 4400, expires_at: at(19) });
    assert.equal(errorOf(short).code, "outside_participant_rules");
    const [b] = await sqlIn<{ code: string }>(db, "SELECT code FROM blocked_manifests");
    assert.equal(b!.code, "latency_mismatch");
    const out = awaitingOf(await ask(server.url, { ...BASE, to: "sim-hb-1f7d", bid_minor: 4400, expires_at: at(20) }));
    assert.equal(out.approval_expires_at, at(15));
  });

  // ---- Approval happens on the hosted approval page -------------------------

  test("Scenario: Link returned: awaiting_approval, A2H-xxxx, an https link on the web host and its expiry; nothing held or delivered", async () => {
    const { db, server } = await fresh();
    const result = await ask(server.url);
    const out = awaitingOf(result);
    assert.match(out.request_id, REQUEST_ID_PATTERN);
    const link = new URL(out.approval_url);
    assert.equal(link.origin, TEST_WEB_ORIGIN);
    assert.equal(link.protocol, "https:");
    assert.equal(link.pathname, `/approve/${out.request_id}`);
    const token = link.searchParams.get("t")!;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    // 24 hours (the request's own expiry minus the 6 h promise is later).
    assert.equal(out.approval_expires_at, new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
    const row = await rowOf(db, out.request_id);
    assert.equal(row.status, "awaiting_approval");
    assert.equal(row.agent_draft, ORIGINAL);
    assert.equal(row.approval_token_hash, await approvalTokenHash(token), "only the token's hash is stored");
    assert.ok(!JSON.stringify(await sqlIn(db, "SELECT * FROM requests")).includes(token), "the token is stored nowhere");
    const events = await sqlIn(db, "SELECT from_status, to_status, actor FROM request_events WHERE request_id = $1", [out.request_id]);
    assert.deepEqual(events, [{ from_status: null, to_status: "awaiting_approval", actor: "principal" }]);
    assert.equal(await deliveries(db), 0);
    const text = texts(result).join("\n");
    assert.ok(text.startsWith("Show the principal this approval link"), text);
    assert.ok(text.includes(out.approval_url));
    assert.match(text, /check_requests/);
    assert.match(text, /nothing (is )?(held|sent)/i);
    assert.ok(!text.includes(ORIGINAL), "the question is on the page, not in the result");
  });

  test("Scenario: Return under a second: A2H-xxxx, status awaiting_approval, the link and its expiry, no hold", async () => {
    const { server } = await fresh();
    await ask(server.url); // warm the pool
    const started = performance.now();
    const result = await ask(server.url);
    const elapsed = performance.now() - started;
    const out = awaitingOf(result);
    assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
    assert.match(out.request_id, REQUEST_ID_PATTERN);
    assert.equal("held_minor" in out, false);
  });

  test("Scenario: Send on the page: sent, delivery left to the worker (the page's decision through the shared transaction)", async () => {
    const { db, server } = await fresh();
    const id = await sendViaPage(db, server);
    assert.equal((await rowOf(db, id)).status, "sent");
    assert.equal(await deliveries(db), 0, "nothing delivered on the request path");
  });

  test("Scenario: Accept after editing: sent with a question byte-identical to the edited text", async () => {
    const { db, server } = await fresh();
    const id = await sendViaPage(db, server, BASE, EDITED);
    const row = await rowOf(db, id);
    assert.equal(row.question, EDITED);
    assert.equal(row.agent_draft, ORIGINAL);
  });

  test("Scenario: Don't send on the page: not_sent, declined; nothing held or delivered", async () => {
    const { db, server } = await fresh();
    const out = awaitingOf(await ask(server.url));
    assert.deepEqual(await approveOnPage(db, out.approval_url, { decision: "dont_send" }), { kind: "not_sent", reason: "declined" });
    const row = await rowOf(db, out.request_id);
    assert.deepEqual([row.status, row.not_sent_reason], ["not_sent", "declined"]);
    assert.equal(await deliveries(db), 0);
  });

  // ---- The link is offered the way the client can show it -------------------

  async function urlRound(server: RunningA2h, args: Args = BASE) {
    const client = await urlClient(server.url);
    const raw = (await callRaw(client, "request_human", args)) as UrlRound | CallToolResult;
    assert.ok((raw as UrlRound).resultType === "input_required", `expected input_required, got ${JSON.stringify(raw).slice(0, 300)}`);
    return { client, round: raw as UrlRound };
  }

  test("Scenario: Client with URL elicitation: input_required with one URL elicitation of the link and a one-sentence message; the eventual result carries the same id and link", async () => {
    const { db, server } = await fresh();
    const { client, round } = await urlRound(server);
    try {
      const entries = Object.entries(round.inputRequests ?? {});
      assert.equal(entries.length, 1);
      const [key, req] = entries[0]!;
      assert.equal(req.method, "elicitation/create");
      assert.equal(req.params.mode, "url");
      assert.equal("elicitationId" in req.params, false, "no elicitationId on 2026-07-28 (design D3)");
      const url = new URL(String(req.params.url));
      assert.equal(url.origin, TEST_WEB_ORIGIN);
      assert.equal(req.params.message.split(/(?<=[.!?])\s+/).filter(Boolean).length, 1, `one sentence: ${req.params.message}`);
      assert.ok(!req.params.message.includes(ORIGINAL));
      assert.equal(typeof round.requestState, "string");
      assert.ok(!round.requestState!.includes("diabetes"), "the state carries no question text");
      const [row] = await sqlIn<{ id: string; status: string }>(db, "SELECT id, status FROM requests");
      assert.equal(row!.status, "awaiting_approval", "recorded before the client asks");
      assert.equal(url.pathname, `/approve/${row!.id}`);
      for (const answer of [{ action: "accept" }, undefined]) {
        const done = await retry(client, "request_human", BASE, round.requestState, answer ? { [key]: answer } : {});
        const out = awaitingOf(done);
        assert.equal(out.request_id, row!.id);
        assert.equal(out.approval_url, url.toString());
      }
      assert.deepEqual(await writeCounts(db), { requests: 1, request_events: 1, blocked_manifests: 0, answers: 0 }, "a retry records nothing new");
    } finally {
      await client.close();
    }
  });

  for (const action of ["decline", "cancel"] as const) {
    test(`Scenario: Principal refuses to open the link (${action}): not_sent, declined, with the request id; nothing held or delivered`, async () => {
      const { db, server } = await fresh();
      const { client, round } = await urlRound(server);
      try {
        const key = Object.keys(round.inputRequests ?? {})[0]!;
        const done = await retry(client, "request_human", BASE, round.requestState, { [key]: { action } });
        assert.ok(!done.isError, texts(done).join(" | "));
        const out = RequestHumanOutputSchema.parse(done.structuredContent);
        assert.equal(out.status, "not_sent");
        assert.equal(out.reason, "declined");
        assert.equal("approval_url" in out, false);
        const row = await rowOf(db, out.request_id);
        assert.deepEqual([row.status, row.not_sent_reason], ["not_sent", "declined"]);
        const text = texts(done).join("\n");
        assert.ok(text.includes(out.request_id));
        assert.match(text, /not sent/i);
        assert.equal(await deliveries(db), 0);
        const link = String(Object.values(round.inputRequests!)[0]!.params.url);
        assert.equal((await approveOnPage(db, link)).kind, "already_decided", "the page shows the decision taken");
      } finally {
        await client.close();
      }
    });
  }

  test("Scenario: Client without URL elicitation: a 2026-07-28 client with forms only, one with no elicitation, and a 2025-era client all get the link in the text, awaiting approval", async () => {
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const { db, server } = await fresh();
    const noElicitation = new Client({ name: "no-elicitation", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await noElicitation.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    let elicited = false;
    const legacy = await legacyClient(server.url, () => {
      elicited = true;
    });
    const forms = await modernClient(server.url);
    try {
      assert.equal(legacy.getProtocolEra(), "legacy");
      for (const client of [forms, noElicitation, legacy]) {
        const raw = (await callRaw(client, "request_human", BASE)) as CallToolResult;
        assert.ok(!isInputRequired(raw));
        const out = awaitingOf(raw);
        assert.ok(texts(raw).join("\n").includes(out.approval_url));
      }
      assert.equal(elicited, false);
      assert.equal((await writeCounts(db))["requests"], 3);
    } finally {
      for (const c of [forms, noElicitation, legacy]) await c.close();
    }
  });

  // ---- The retry: its state is ours and bound to the principal -----------------

  test("A forged or altered requestState is refused before any handler runs (-32602), and nothing changes", async () => {
    const { db, server } = await fresh();
    const { client, round } = await urlRound(server);
    try {
      const key = Object.keys(round.inputRequests ?? {})[0]!;
      const parts = round.requestState!.split(".");
      const altered = [...parts.slice(0, -1), flipMiddle(parts.at(-1)!)].join(".");
      for (const state of ["v1.e30.AAAA", altered]) {
        await assert.rejects(retry(client, "request_human", BASE, state, { [key]: { action: "decline" } }), (e: unknown) => e instanceof ProtocolError && e.code === -32602);
      }
      const [row] = await sqlIn<{ status: string }>(db, "SELECT status FROM requests");
      assert.equal(row!.status, "awaiting_approval");
    } finally {
      await client.close();
    }
  });

  test("A retry without requestState is a conflict, and another principal's state is refused; nothing changes", async () => {
    const { db, server } = await fresh();
    const other = await startA2h(db, { principal: { ...TEST_PRINCIPAL, principal_id: "another-principal" } });
    running.push(other);
    const { client, round } = await urlRound(server);
    const stranger = await urlClient(other.url);
    try {
      const key = Object.keys(round.inputRequests ?? {})[0]!;
      const noState = await retry(client, "request_human", BASE, undefined, { [key]: { action: "decline" } });
      assert.equal(errorOf(noState).code, "conflict");
      await assert.rejects(retry(stranger, "request_human", BASE, round.requestState, { [key]: { action: "decline" } }), (e: unknown) => e instanceof ProtocolError && e.code === -32602);
      const [row] = await sqlIn<{ status: string }>(db, "SELECT status FROM requests");
      assert.equal(row!.status, "awaiting_approval");
      assert.equal((await writeCounts(db))["requests"], 1);
    } finally {
      await client.close();
      await stranger.close();
    }
  });

  test("The round trip works across two instances: state minted on one verifies on the other", async () => {
    const { db, server: a } = await fresh();
    const b = await startA2h(db);
    running.push(b);
    let next = 0;
    const legs: string[] = [];
    const roundRobin: FetchLike = async (input, init) => {
      const origin = [a.origin, b.origin][next++ % 2]!;
      const url = new URL(input.toString());
      if (typeof init?.body === "string" && init.body.includes('"tools/call"')) legs.push(origin);
      return fetch(`${origin}${url.pathname}${url.search}`, init);
    };
    const client = await urlClient(a.url, roundRobin);
    try {
      const round = (await callRaw(client, "request_human", BASE)) as unknown as UrlRound;
      assert.equal(round.resultType, "input_required");
      const key = Object.keys(round.inputRequests ?? {})[0]!;
      const done = await retry(client, "request_human", BASE, round.requestState, { [key]: { action: "decline" } });
      assert.equal(RequestHumanOutputSchema.parse(done.structuredContent).status, "not_sent");
      assert.equal(legs.length, 2);
      assert.notEqual(legs[0], legs[1]);
    } finally {
      await client.close();
    }
  });

  // ---- Agent cannot approve ------------------------------------------------

  test("Scenario: Agent cannot approve: no tool offers the transition; accept on the retry, repeated calls and check_requests leave the request awaiting_approval", async () => {
    const { db, server } = await fresh();
    const { client, round } = await urlRound(server);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["check_requests", "find_humans", "ping", "request_human"]);
      for (const t of tools) {
        const props = Object.keys((t.inputSchema.properties ?? {}));
        assert.ok(!props.some((k) => /approv|decision|token/i.test(k)), `${t.name} takes no approval input: ${props.join(",")}`);
      }
      const key = Object.keys(round.inputRequests ?? {})[0]!;
      for (let i = 0; i < 3; i++) await retry(client, "request_human", BASE, round.requestState, { [key]: { action: "accept", content: { question: EDITED } } });
      const out = awaitingOf(await retry(client, "request_human", BASE, round.requestState, { [key]: { action: "accept" } }));
      await client.callTool({ name: "check_requests", arguments: { request_id: out.request_id } });
      const row = await rowOf(db, out.request_id);
      assert.equal(row.status, "awaiting_approval");
      assert.equal(row.question, ORIGINAL, "accept content never edits the question");
      assert.equal(await deliveries(db), 0);
    } finally {
      await client.close();
    }
  });

  // ---- Shapes outside this change ---------------------------------------------

  for (const [field, value, milestone] of [
    ["attachments", [{ ref: "att-1", media_type: "application/pdf", size_bytes: 1000 }], "M3"],
    ["audience", "panel_sample", "M3"],
    ["audience", "population_in_place", "M3"],
    ["audience", "role_qualified_first_to_accept", "M3"],
    ["time_shape", "threaded", "M3"],
    ["time_shape", "recurring", "M3"],
  ] as const) {
    test(`Scenario: Shape outside this change: ${field} ${JSON.stringify(value).slice(0, 30)} is schema_invalid naming the field and ${milestone}, nothing recorded`, async () => {
      const { db, server } = await fresh();
      const error = errorOf(await ask(server.url, { ...BASE, [field]: value }));
      assert.equal(error.code, "schema_invalid");
      assert.match(error.detail ?? "", new RegExp(field));
      assert.match(error.detail ?? "", new RegExp(milestone));
      assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
    });
  }

  // ---- Every request carries its principal -----------------------------------

  test("Scenario: Principal recorded: the request carries the principal id; another principal gets not_found", async () => {
    const { db, server } = await fresh();
    const id = awaitingOf(await ask(server.url)).request_id;
    const [row] = await sqlIn<{ principal_id: string }>(db, "SELECT principal_id FROM requests WHERE id = $1", [id]);
    assert.equal(row!.principal_id, TEST_PRINCIPAL.principal_id);
    const stranger = await startA2h(db, { principal: { ...TEST_PRINCIPAL, principal_id: "another-principal" } });
    running.push(stranger);
    const client = await modernClient(stranger.url);
    try {
      const checked = await client.callTool({ name: "check_requests", arguments: { request_id: id } });
      assert.equal(errorOf(checked).code, "not_found");
      assert.ok(!JSON.stringify(checked).includes("sim-mv-7f3c"), "reveals nothing else");
    } finally {
      await client.close();
    }
  });

  test("Scenario: Blocked row: participant id, principal id, stage, code and time; no column holds the question", async () => {
    const { db, server } = await fresh();
    errorOf(await ask(server.url, { ...BASE, bid_minor: 100 }));
    const rows = await sqlIn<Record<string, unknown>>(db, "SELECT * FROM blocked_manifests");
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row["participant_id"], "p_sim_mv_7f3c");
    assert.equal(row["principal_id"], TEST_PRINCIPAL.principal_id);
    assert.equal(row["stage"], "rules");
    assert.equal(row["code"], "bid_below_reserve");
    assert.ok(row["at"] instanceof Date);
    assert.ok(!JSON.stringify(row).includes("diabetes"));
    assert.deepEqual(Object.keys(row).sort(), ["at", "code", "id", "participant_id", "principal_id", "request_id", "stage"]);
  });

  test("The development principal cannot send an authorisation request (design D7)", async () => {
    const { db, server } = await fresh({ principal: { principal_id: "dev-principal-test", identity_mode: "verified_organisation", verified: true } });
    assert.equal(errorOf(await ask(server.url, { ...BASE, intent: "authorisation" })).code, "principal_not_verified_for_lane");
    assert.equal((await writeCounts(db))["requests"], 0);
  });

  test("An unknown handle is not_found; a fractional bid is schema_invalid", async () => {
    const { server } = await fresh();
    assert.equal(errorOf(await ask(server.url, { ...BASE, to: "sim-zz-0000" })).code, "not_found");
    const error = errorOf(await ask(server.url, { ...BASE, bid_minor: 30.5 }));
    assert.equal(error.code, "schema_invalid");
    assert.match(error.detail ?? "", /bid_minor/);
  });

  test("A free-lane request says nothing will be held, and holds nothing when sent", async () => {
    const { db, server } = await fresh();
    const args = { ...BASE, lane: "free", free_lane: "own_publications", bid_minor: 0, question: "In your 2024 leaflet guide, which section did you write first?" };
    const result = await ask(server.url, args);
    const out = awaitingOf(result);
    assert.match(texts(result).join("\n"), /free lane/i);
    const decided = await approveOnPage(db, out.approval_url);
    assert.equal(decided.kind === "sent" && decided.held_minor, 0);
  });

  test("A poll is recorded with its options exactly; a forbidden option label is refused like the question", async () => {
    const { db, server } = await fresh();
    const POLL = {
      ...BASE,
      to: "sim-ep-5c07",
      intent: "opinion",
      format: "poll",
      bid_minor: 1100,
      question: "Which cover makes a five-year-old want to open the book?",
      options: [
        { id: "a", label: "The fox in the rain (cover A)" },
        { id: "b", label: "Night garden, «lanterns» & owls — cover B" },
      ],
    };
    const out = awaitingOf(await ask(server.url, POLL));
    const [row] = await sqlIn<{ options: unknown }>(db, "SELECT options FROM requests WHERE id = $1", [out.request_id]);
    assert.deepEqual(row!.options, POLL.options);
    const bad = await ask(server.url, { ...POLL, options: [POLL.options[0], { id: "b", label: PUSH_POLL }] });
    assert.equal(errorOf(bad).code, "forbidden_content");
  });
});
