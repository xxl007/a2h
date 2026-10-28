// Task 4.3: request_human, one test per scenario of
// openspec/changes/m1-protocol-connector/specs/protocol/request-approval/spec.md
// (design D1, D7; owner decision 5, option 1), against the real tools, the
// real 2026-07-28 round trip with the official client, and Postgres 17.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ProtocolError, type CallToolResult, type FetchLike } from "@modelcontextprotocol/client";
import { REQUEST_ID_PATTERN, RequestHumanOutputSchema, gross } from "@a2h/protocol";
import type { DbConfig } from "../src/config.ts";
import { freshSchema, skipWithoutDocker, sqlIn, startPostgres, writeCounts, type PgContainer } from "./lib/db.ts";
import {
  NOW,
  TEST_PRINCIPAL,
  callRaw,
  isInputRequired,
  legacyClient,
  modernClient,
  retry,
  startA2h,
  texts,
  type A2hOptions,
  type ElicitParams,
  type InputRequiredRound,
  type RunningA2h,
} from "./lib/a2h.ts";
import { BASE, EDITED, LABOUR, ORIGINAL, PUSH_POLL, THIRD_PARTY } from "./lib/fixtures.ts";

type Args = Record<string, unknown>;

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

  /** A fresh schema (migrated and seeded) and a server on it. */
  async function fresh(options: A2hOptions = {}): Promise<{ db: DbConfig; server: RunningA2h }> {
    const db = await freshSchema(pgc);
    const server = await startA2h(db, options);
    running.push(server);
    return { db, server };
  }

  async function firstRound(url: string, args: Args = BASE): Promise<{ round: InputRequiredRound; client: Awaited<ReturnType<typeof modernClient>> }> {
    const client = await modernClient(url);
    const raw = await callRaw(client, "request_human", args);
    assert.ok(isInputRequired(raw), `expected input_required, got ${JSON.stringify(raw)}`);
    return { round: raw, client };
  }

  async function sendAccepted(url: string, args: Args = BASE, question?: string): Promise<CallToolResult> {
    const client = await modernClient(url, (p) => ({ action: "accept", content: { question: question ?? String(p.requestedSchema.properties["question"]?.["default"]) } }));
    try {
      return (await client.callTool({ name: "request_human", arguments: args }));
    } finally {
      await client.close();
    }
  }

  function errorOf(result: CallToolResult): { code: string; stage: string; retryable: boolean; detail?: string } {
    assert.equal(result.isError, true, `expected an error result: ${texts(result).join(" | ")}`);
    return (result.structuredContent as { error: { code: string; stage: string; retryable: boolean; detail?: string } }).error;
  }

  async function questions(db: DbConfig): Promise<string[]> {
    return (await sqlIn<{ question: string }>(db, "SELECT question FROM requests ORDER BY created_at")).map((r) => r.question);
  }

  // ---- Manifest validation runs before anything else ----------------------

  test("Scenario: Bid below reserve: outside_participant_rules, no approval shown, nothing created, reserve not stated", async () => {
    const { db, server } = await fresh();
    const client = await modernClient(server.url);
    try {
      const reserve = gross(2500, 0.2); // 3125
      const raw = await callRaw(client, "request_human", { ...BASE, bid_minor: reserve - 1 });
      assert.ok(!isInputRequired(raw), "no approval is shown");
      const error = errorOf(raw);
      assert.equal(error.code, "outside_participant_rules");
      assert.equal(error.stage, "rules");
      const everything = JSON.stringify(raw);
      for (const leak of ["3125", "31.25", "2500", "25.00", "reserve"]) assert.ok(!everything.toLowerCase().includes(leak), `detail leaks ${leak}`);
      const counts = await writeCounts(db);
      assert.equal(counts["requests"], 0);
      assert.equal(counts["request_events"], 0);
      assert.equal(counts["blocked_manifests"], 1, "the block is counted for the participant");
    } finally {
      await client.close();
    }
  });

  for (const [name, question, code] of [
    ["Push-poll", PUSH_POLL, "forbidden_content"],
    ["Third-party personal data", THIRD_PARTY, "forbidden_content"],
    ["Labour disguised as a question", LABOUR, "forbidden_content"],
  ] as const) {
    test(`Scenario: ${name}: ${code} at stage content, no approval shown, nothing created`, async () => {
      const { db, server } = await fresh();
      const client = await modernClient(server.url);
      try {
        const raw = await callRaw(client, "request_human", { ...BASE, question });
        assert.ok(!isInputRequired(raw), "no approval is shown");
        const error = errorOf(raw);
        assert.equal(error.code, code);
        assert.equal(error.stage, "content");
        assert.ok(!JSON.stringify(raw).includes(question), "the question is not echoed");
        assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
      } finally {
        await client.close();
      }
    });
  }

  test("Scenario: Quiet hours: deferred delivery when the expiry allows, retryable refusal when it does not", async () => {
    // sim-ep-5c07: quiet 22:00-07:00 Europe/London, latency promise 24 h, judgment net 2000 (gross 2500).
    const late = new Date("2026-10-27T23:00:00Z");
    const { db, server } = await fresh({ now: () => late });
    const args = { ...BASE, to: "sim-ep-5c07", bid_minor: 2600, expires_at: "2026-10-30T12:00:00+00:00" };
    const result = await sendAccepted(server.url, args);
    assert.ok(!result.isError, texts(result).join(" | "));
    const out = RequestHumanOutputSchema.parse(result.structuredContent);
    assert.equal(out.status, "sent");
    assert.equal(out.deferred, true);
    assert.equal(new Date(out.deliver_at!).toISOString(), "2026-10-28T07:00:00.000Z");
    assert.match(texts(result).join("\n"), /deferred/i);

    const tooSoon = await sendAccepted(server.url, { ...args, expires_at: "2026-10-28T20:00:00+00:00" });
    const error = errorOf(tooSoon);
    assert.equal(error.code, "outside_participant_rules");
    assert.equal(error.retryable, true);
    assert.equal((await writeCounts(db))["requests"], 1);
  });

  test("Scenario: Interruption budget exceeded: outside_participant_rules and the block is counted", async () => {
    // sim-bk-2e6f accepts at most 2 interruptions a day; estimate net 3500 (gross 4375).
    const { db, server } = await fresh();
    const args = { ...BASE, to: "sim-bk-2e6f", intent: "estimate", question: "How many days does road freight from Lyon to Rotterdam take this month?", bid_minor: 4400 };
    for (let i = 0; i < 2; i++) assert.ok(!(await sendAccepted(server.url, args)).isError);
    const third = await sendAccepted(server.url, args);
    assert.equal(errorOf(third).code, "outside_participant_rules");
    const blocked = await sqlIn<{ code: string }>(db, "SELECT code FROM blocked_manifests");
    assert.deepEqual(blocked.map((b) => b.code), ["interruption_budget"]);
    assert.equal((await writeCounts(db))["requests"], 2);
  });

  // ---- Approval shows the exact wording ------------------------------------

  test("Approval: one pre-filled text field holding the question; message with gross bid, format, expiry, data terms and Send · hold", async () => {
    const { server } = await fresh();
    const { round, client } = await firstRound(server.url);
    try {
      assert.deepEqual(Object.keys(round.inputRequests ?? {}), ["approval"]);
      const req = round.inputRequests!["approval"]!;
      assert.equal(req.method, "elicitation/create");
      const params: ElicitParams = req.params;
      assert.ok(params.mode === undefined || params.mode === "form");
      assert.deepEqual(Object.keys(params.requestedSchema.properties), ["question"], "exactly one field");
      assert.equal(params.requestedSchema.properties["question"]!["type"], "string");
      assert.equal(params.requestedSchema.properties["question"]!["default"], ORIGINAL);
      assert.match(params.message, /€32\.00/);
      assert.match(params.message, /Send · hold €32\.00/);
      assert.match(params.message, /single_field|single field/);
      assert.match(params.message, /2026-10-29/);
      assert.match(params.message, /workspace/i);
      assert.match(params.message, /attributed/i);
      assert.match(params.message, /training/i);
      assert.ok(!params.message.includes(ORIGINAL), "the question is in the field, not repeated in the message");
      assert.equal(typeof round.requestState, "string");
      assert.ok(!round.requestState!.includes("diabetes"), "the state carries no question text");
    } finally {
      await client.close();
    }
  });

  test("Scenario: Accept after editing: one request whose question is byte-identical to the edited text", async () => {
    const { db, server } = await fresh();
    let seenDefault: unknown;
    const client = await modernClient(server.url, (p) => {
      seenDefault = p.requestedSchema.properties["question"]?.["default"];
      return { action: "accept", content: { question: EDITED } };
    });
    try {
      const result = (await client.callTool({ name: "request_human", arguments: BASE }));
      assert.ok(!result.isError, texts(result).join(" | "));
      assert.equal(seenDefault, ORIGINAL);
      assert.deepEqual(await questions(db), [EDITED]);
      const [bytes] = await sqlIn<{ hex: string }>(db, "SELECT encode(convert_to(question, 'UTF8'), 'hex') AS hex FROM requests");
      assert.equal(bytes!.hex, Buffer.from(EDITED, "utf8").toString("hex"));
      assert.deepEqual(await writeCounts(db), { requests: 1, request_events: 1, blocked_manifests: 0, answers: 0 });
    } finally {
      await client.close();
    }
  });

  for (const [scenario, action, reason] of [
    ["Decline", "decline", "declined"],
    ["Dismissed", "cancel", "dismissed"],
  ] as const) {
    test(`Scenario: ${scenario}: nothing is created, the result says not sent, check_requests knows no id`, async () => {
      const { db, server } = await fresh();
      const { round, client } = await firstRound(server.url);
      try {
        const result = await retry(client, "request_human", BASE, round.requestState, { approval: { action } });
        assert.ok(!result.isError, texts(result).join(" | "));
        const out = RequestHumanOutputSchema.parse(result.structuredContent);
        assert.deepEqual(out, { status: "not_sent", reason });
        assert.match(texts(result).join("\n"), /not sent/i);
        assert.ok(!texts(result).join("\n").includes(ORIGINAL), "no question text echoed");
        assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
        const listed = (await client.callTool({ name: "check_requests", arguments: {} }));
        assert.deepEqual((listed.structuredContent as { requests: unknown[] }).requests, []);
      } finally {
        await client.close();
      }
    });
  }

  test("Scenario: Forged or expired approval state: refused before any handler runs with -32602 invalid_request_state", async (t) => {
    const { db, server } = await fresh();
    const other = await fresh({ approvalKey: Uint8Array.from({ length: 32 }, () => 7) });
    const { round, client } = await firstRound(server.url);
    const foreign = await firstRound(other.server.url);
    try {
      const state = round.requestState!;
      const tampered = state.slice(0, -1) + (state.at(-1) === "A" ? "B" : "A");
      const accept = { approval: { action: "accept", content: { question: ORIGINAL } } };
      for (const bad of [tampered, foreign.round.requestState!, "v1.e30.AAAA", "not-a-state"]) {
        await assert.rejects(retry(client, "request_human", BASE, bad, accept), (error: unknown) => {
          assert.ok(error instanceof ProtocolError, `not a ProtocolError: ${String(error)}`);
          assert.equal(error.code, -32602);
          assert.equal((error.data as { reason?: string } | undefined)?.reason, "invalid_request_state");
          return true;
        });
      }
      // Expired: the same genuine state, presented after fifteen minutes.
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 15 * 60 * 1000 + 5_000 });
      await assert.rejects(retry(client, "request_human", BASE, state, accept), (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.equal(error.code, -32602);
        assert.equal((error.data as { reason?: string } | undefined)?.reason, "invalid_request_state");
        return true;
      });
      t.mock.timers.reset();
      assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
    } finally {
      t.mock.timers.reset();
      await client.close();
      await foreign.client.close();
    }
  });

  test("Scenario: Approval state replayed with changed arguments: conflict, nothing created", async () => {
    const { db, server } = await fresh();
    const { round, client } = await firstRound(server.url);
    try {
      const accept = { approval: { action: "accept", content: { question: ORIGINAL } } };
      for (const changed of [{ ...BASE, bid_minor: 3300 }, { ...BASE, to: "sim-ol-6a23" }, { ...BASE, expires_at: "2026-10-30T09:00:00+00:00" }]) {
        const result = await retry(client, "request_human", changed, round.requestState, accept);
        assert.equal(errorOf(result).code, "conflict");
      }
      const missing = await retry(client, "request_human", BASE, undefined, accept);
      assert.equal(errorOf(missing).code, "conflict", "a retry without state is a conflict too");
      assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
    } finally {
      await client.close();
    }
  });

  test("Scenario: Client on an older revision: an error result saying how to enable 2026-07-28, nothing created, never asked", async () => {
    const { db, server } = await fresh();
    let elicited = false;
    const client = await legacyClient(server.url, () => {
      elicited = true;
    });
    try {
      assert.equal(client.getProtocolEra(), "legacy");
      const result = (await client.callTool({ name: "request_human", arguments: BASE }));
      assert.equal(result.isError, true);
      const text = texts(result).join("\n");
      assert.match(text, /2026-07-28/);
      assert.match(text, /MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude/);
      assert.match(text, /nothing (was )?(created|sent)/i);
      assert.equal(elicited, false);
      assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
      // find_humans and check_requests work on either revision.
      assert.ok(!((await client.callTool({ name: "find_humans", arguments: { topic: "leaflets", request_type: "judgment" } }))).isError);
    } finally {
      await client.close();
    }
  });

  test("A 2026-07-28 client that cannot show a form is told so, and nothing is created", async () => {
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const { db, server } = await fresh();
    const client = new Client({ name: "no-forms", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    try {
      const raw = await callRaw(client, "request_human", BASE);
      assert.ok(!isInputRequired(raw));
      assert.equal(raw.isError, true);
      assert.match(texts(raw).join("\n"), /elicitation|form/i);
      assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
    } finally {
      await client.close();
    }
  });

  // ---- Approval covers the validated manifest ------------------------------

  test("Scenario: Edit turns the question into a push-poll: forbidden_content and no request exists", async () => {
    const { db, server } = await fresh();
    const { round, client } = await firstRound(server.url);
    try {
      const result = await retry(client, "request_human", BASE, round.requestState, { approval: { action: "accept", content: { question: PUSH_POLL } } });
      assert.equal(errorOf(result).code, "forbidden_content");
      assert.deepEqual(await writeCounts(db), { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
    } finally {
      await client.close();
    }
  });

  test("An accepted empty or non-text question is schema_invalid and creates nothing", async () => {
    const { db, server } = await fresh();
    const { round, client } = await firstRound(server.url);
    try {
      for (const question of ["   ", 42]) {
        const result = await retry(client, "request_human", BASE, round.requestState, { approval: { action: "accept", content: { question } } });
        assert.equal(errorOf(result).code, "schema_invalid");
      }
      assert.equal((await writeCounts(db))["requests"], 0);
    } finally {
      await client.close();
    }
  });

  // ---- Fast return, delivery later ------------------------------------------

  test("Scenario: Return under a second: A2H-xxxx, an ETA, status sent, held = gross bid", async () => {
    const { db, server } = await fresh();
    const { round, client } = await firstRound(server.url);
    try {
      const started = performance.now();
      const result = await retry(client, "request_human", BASE, round.requestState, { approval: { action: "accept", content: { question: ORIGINAL } } });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
      assert.ok(!result.isError, texts(result).join(" | "));
      const out = RequestHumanOutputSchema.parse(result.structuredContent);
      assert.equal(out.status, "sent");
      assert.match(out.request_id!, REQUEST_ID_PATTERN);
      assert.equal(out.held_minor, BASE.bid_minor);
      assert.equal(out.currency, "EUR");
      assert.equal(out.deferred, false);
      assert.equal(new Date(out.deliver_at!).getTime(), NOW.getTime());
      assert.equal(new Date(out.eta!).getTime(), NOW.getTime() + 6 * 3600 * 1000, "ETA: the participant's latency promise");
      const text = texts(result).join("\n");
      assert.match(text, new RegExp(out.request_id!));
      assert.match(text, /€32\.00/);
      const [row] = await sqlIn<{ status: string; bid_minor: number }>(db, "SELECT status, bid_minor FROM requests WHERE id = $1", [out.request_id]);
      assert.deepEqual(row, { status: "sent", bid_minor: 3200 });
    } finally {
      await client.close();
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
    const client = await modernClient(a.url, () => ({ action: "accept", content: { question: EDITED } }), roundRobin);
    try {
      const result = (await client.callTool({ name: "request_human", arguments: BASE }));
      assert.ok(!result.isError, texts(result).join(" | "));
      assert.equal(legs.length, 2);
      assert.notEqual(legs[0], legs[1]);
      assert.deepEqual(await questions(db), [EDITED]);
    } finally {
      await client.close();
    }
  });

  // ---- Every request carries its principal -----------------------------------

  test("Scenario: Principal recorded: the request carries the principal id; another principal gets not_found", async () => {
    const { db, server } = await fresh();
    const result = await sendAccepted(server.url);
    const id = RequestHumanOutputSchema.parse(result.structuredContent).request_id!;
    const [row] = await sqlIn<{ principal_id: string }>(db, "SELECT principal_id FROM requests WHERE id = $1", [id]);
    assert.equal(row!.principal_id, TEST_PRINCIPAL.principal_id);
    const [event] = await sqlIn<{ from_status: string | null; to_status: string; actor: string }>(db, "SELECT from_status, to_status, actor FROM request_events WHERE request_id = $1", [id]);
    assert.deepEqual(event, { from_status: null, to_status: "sent", actor: "principal" });

    const stranger = await startA2h(db, { principal: { ...TEST_PRINCIPAL, principal_id: "another-principal" } });
    running.push(stranger);
    const client = await modernClient(stranger.url);
    try {
      const checked = (await client.callTool({ name: "check_requests", arguments: { request_id: id } }));
      assert.equal(errorOf(checked).code, "not_found");
      assert.ok(!JSON.stringify(checked).includes("sim-mv-7f3c"), "reveals nothing else");
    } finally {
      await client.close();
    }
  });

  // ---- Blocked manifests are counted without content -------------------------

  test("Scenario: Blocked row: participant id, principal id, stage, code and time; no column holds the question", async () => {
    const { db, server } = await fresh();
    const client = await modernClient(server.url);
    try {
      const raw = await callRaw(client, "request_human", { ...BASE, bid_minor: 100 });
      assert.ok(!isInputRequired(raw));
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
    } finally {
      await client.close();
    }
  });

  // ---- other refusals ---------------------------------------------------------

  test("The development principal cannot send an authorisation request (design D7)", async () => {
    const { db, server } = await fresh();
    const client = await modernClient(server.url);
    try {
      const raw = await callRaw(client, "request_human", { ...BASE, intent: "authorisation" });
      assert.ok(!isInputRequired(raw));
      assert.equal(errorOf(raw).code, "principal_not_verified_for_lane");
      assert.equal((await writeCounts(db))["requests"], 0);
    } finally {
      await client.close();
    }
  });

  test("An unknown handle is not_found; a fractional bid is schema_invalid", async () => {
    const { server } = await fresh();
    const client = await modernClient(server.url);
    try {
      const unknown = await callRaw(client, "request_human", { ...BASE, to: "sim-zz-0000" });
      assert.ok(!isInputRequired(unknown));
      assert.equal(errorOf(unknown).code, "not_found");
      const fractional = await callRaw(client, "request_human", { ...BASE, bid_minor: 30.5 });
      assert.ok(!isInputRequired(fractional));
      const error = errorOf(fractional);
      assert.equal(error.code, "schema_invalid");
      assert.match(error.detail ?? "", /bid_minor/);
    } finally {
      await client.close();
    }
  });

  test("A free-lane request holds nothing and says so", async () => {
    const { server } = await fresh();
    const args = { ...BASE, lane: "free", free_lane: "own_publications", bid_minor: 0, question: "In your 2024 leaflet guide, which section did you write first?" };
    const { round, client } = await firstRound(server.url, args);
    try {
      assert.match(round.inputRequests!["approval"]!.params.message, /nothing (is )?held|free lane/i);
      const result = await retry(client, "request_human", args, round.requestState, { approval: { action: "accept", content: { question: args.question } } });
      const out = RequestHumanOutputSchema.parse(result.structuredContent);
      assert.equal(out.held_minor, 0);
    } finally {
      await client.close();
    }
  });
});
