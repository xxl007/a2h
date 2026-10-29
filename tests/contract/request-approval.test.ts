// Contract tests against a live stage for
// openspec/changes/archive/2026-10-29-m1-protocol-connector/specs/protocol/request-approval/spec.md:
// the refusals and the approval round trip that create nothing, driven with
// the official v2 client on the 2026-07-28 revision. The scenarios that need
// a created request (Accept after editing, Return under a second, Accepted
// approval replayed, Principal recorded) are in request-flows.test.ts, which
// reuses one request for all of them.
//
// "Nothing is created" is checked from outside: check_requests lists no new
// request to the handle used. The handles used here (sim-mv-7f3c,
// sim-ol-6a23, sim-ep-5c07) are never sent to by request-flows.test.ts.
// Run: A2H_MCP_URL=http://<alb>/pr-<n>/mcp pnpm --filter @a2h/tests contract
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ProtocolError } from "@modelcontextprotocol/client";
import { RequestHumanOutputSchema } from "@a2h/protocol";
import {
  accept,
  approvalRound,
  assertNothingCreatedFor,
  errorOf,
  expiresIn,
  firstLeg,
  isInputRequired,
  legacyClient,
  manifest,
  principalClient,
  retryLeg,
  serverNow,
  texts,
  type A2hClient,
  type Answer,
} from "./a2h.ts";

const MV = "sim-mv-7f3c"; // judgment, net 2500 → gross 3125, prompt persona, latency 6 h
const QUESTION = "Would a patient with type 2 diabetes find the insulin section of this leaflet alarming?";
const EDITED = "Would a newly diagnosed patient find the insulin section alarming? (é, «quotes», 中文)";
const PUSH_POLL = "Would you still trust this clinic if you learned its director lied about the results?";
const THIRD_PARTY = "What is your colleague's home address?";
const LABOUR = "Please write a 2,000-word report on insulin pricing.";

const base = (extra: Record<string, unknown> = {}) => manifest(MV, "judgment", 3200, QUESTION, extra);

function assertInvalidState(error: unknown): true {
  assert.ok(error instanceof ProtocolError, `not a JSON-RPC error: ${String(error)}`);
  assert.equal(error.code, -32602);
  assert.equal((error.data as { reason?: string } | undefined)?.reason, "invalid_request_state");
  return true;
}

describe("protocol/request-approval (live)", () => {
  let c: A2hClient;
  let started: Date;
  before(async () => {
    c = await principalClient();
    started = serverNow();
  });
  after(async () => {
    await c?.close();
  });

  // ---- Manifest validation runs before anything else -----------------------

  test("Scenario: Bid below reserve", async () => {
    const since = serverNow();
    const raw = await firstLeg(c, base({ bid_minor: 3124 }));
    assert.ok(!isInputRequired(raw), "no approval is shown");
    const error = errorOf(raw);
    assert.equal(error.code, "outside_participant_rules");
    assert.equal(error.stage, "rules");
    const everything = JSON.stringify(raw).toLowerCase();
    for (const leak of ["3125", "31.25", "2500", "25.00", "reserve"]) assert.ok(!everything.includes(leak), `the refusal states the reserve (${leak})`);
    await assertNothingCreatedFor(c, MV, since);
  });

  for (const [scenario, question] of [
    ["Push-poll", PUSH_POLL],
    ["Third-party personal data", THIRD_PARTY],
    ["Labour disguised as a question", LABOUR],
  ] as const) {
    test(`Scenario: ${scenario}`, async () => {
      const since = serverNow();
      const raw = await firstLeg(c, base({ question }));
      assert.ok(!isInputRequired(raw), "no approval is shown");
      const error = errorOf(raw);
      assert.equal(error.code, "forbidden_content");
      assert.equal(error.stage, "content");
      assert.ok(!JSON.stringify(raw).includes(question), "the question is not echoed");
      await assertNothingCreatedFor(c, MV, since);
    });
  }

  test("Scenario: Quiet hours (branch decided by the server's clock in Europe/London)", async (t) => {
    // sim-ep-5c07: quiet 22:00-07:00 Europe/London, latency 24 h, judgment net 2000 (gross 2500).
    // The server's clock cannot be set from outside: by day the deferral is
    // not observable and only "delivery now" is checked; the deferred and
    // refused branches run between 22:00 and 07:00 London time (or on the
    // local stage with a pinned clock), and in apps/mcp/test/request-human.test.ts.
    const EP = "sim-ep-5c07";
    const since = serverNow();
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(serverNow()));
    const quiet = hour >= 22 || hour < 7;
    const args = manifest(EP, "judgment", 2600, "Is the vocabulary of this picture book right for five-year-olds?", { expires_at: expiresIn(3 * 86_400) });
    const round = await approvalRound(c, args);
    const message = round.inputRequests!["approval"]!.params.message;
    if (!quiet) {
      assert.match(message, /Delivery: now/, "outside quiet hours the delivery is now");
      t.diagnostic(`London hour ${hour}: outside quiet hours, deferral not observable now`);
    } else {
      assert.match(message, /deferred to/i, "inside quiet hours the approval says the delivery is deferred");
      // An expiry shorter than the 24 h latency from now cannot fit a deferred delivery: refused, retryable.
      const tooSoon = await firstLeg(c, { ...args, expires_at: expiresIn(23 * 3600) });
      const error = errorOf(tooSoon);
      assert.equal(error.code, "outside_participant_rules");
      assert.equal(error.retryable, true);
    }
    const declined = await retryLeg(c, args, round.requestState, { action: "decline" });
    assert.equal(RequestHumanOutputSchema.parse(declined.structuredContent).status, "not_sent");
    await assertNothingCreatedFor(c, EP, since);
  });

  test("Scenario: Interruption budget exceeded", async () => {
    // sim-bk-2e6f accepts at most 2 interruptions a UTC day (silent persona,
    // latency 24 h, estimate net 3500 → gross 4375). Requests are sent until
    // it refuses: at most two are created per UTC day on a stage (earlier runs
    // the same day leave fewer or none to create). Their holds are released
    // when they expire, a day later.
    const BK = "sim-bk-2e6f";
    const args = manifest(BK, "estimate", 4400, "How many days does road freight from Lyon to Rotterdam take this month?");
    let refused: ReturnType<typeof errorOf> | undefined;
    for (let attempt = 1; attempt <= 3 && !refused; attempt++) {
      const raw = await firstLeg(c, args);
      if (!isInputRequired(raw)) {
        refused = errorOf(raw);
        break;
      }
      const sent = await retryLeg(c, args, raw.requestState, accept(String(args["question"])));
      if (sent.isError) refused = errorOf(sent);
      else assert.equal(RequestHumanOutputSchema.parse(sent.structuredContent).status, "sent");
    }
    assert.ok(refused, "a third request on the same UTC day is refused");
    assert.equal(refused.code, "outside_participant_rules");
    assert.equal(refused.stage, "rules");
    assert.ok(!/interruption|per day|2 /i.test(refused.detail ?? ""), `the detail reveals the participant's rule: ${refused.detail}`);
    // "The block is counted for the participant" (a blocked_manifests row
    // with code interruption_budget) is not visible from outside:
    // apps/mcp/test/request-human.test.ts "Scenario: Interruption budget exceeded".
  });

  // ---- Approval shows the exact wording -------------------------------------

  test("Approval shows the exact wording: one pre-filled field, the terms in the message, Send · hold", async () => {
    const since = serverNow();
    const round = await approvalRound(c, base());
    assert.deepEqual(Object.keys(round.inputRequests ?? {}), ["approval"]);
    const req = round.inputRequests!["approval"]!;
    assert.equal(req.method, "elicitation/create");
    const { message, requestedSchema, mode } = req.params;
    assert.ok(mode === undefined || mode === "form");
    assert.deepEqual(Object.keys(requestedSchema.properties), ["question"], "exactly one field");
    assert.equal(requestedSchema.properties["question"]!["type"], "string");
    assert.equal(requestedSchema.properties["question"]!["default"], QUESTION, "pre-filled with the question, verbatim");
    assert.match(message, /€32\.00/, "the gross bid");
    // "Send · hold €N" is wording in the message (form elicitation cannot label buttons); it closes the message.
    const lastLine = message.trim().split("\n").at(-1) ?? "";
    assert.match(lastLine, /Send · hold €32\.00/, `the message's last line states the consequence: ${JSON.stringify(lastLine)}`);
    assert.match(message, /single field/, "the format");
    assert.ok(message.includes(String(base()["expires_at"]).slice(0, 10)), "the expiry");
    assert.match(message, /workspace/i);
    assert.match(message, /attributed/i);
    assert.match(message, /training/i);
    assert.ok(!message.includes(QUESTION), "the question is the field, not repeated in the message");
    await retryLeg(c, base(), round.requestState, { action: "cancel" });
    await assertNothingCreatedFor(c, MV, since);
  });

  for (const [scenario, answer, reason] of [
    ["Decline", { action: "decline" }, "declined"],
    ["Dismissed", { action: "cancel" }, "dismissed"],
  ] as const satisfies readonly (readonly [string, Answer, string])[]) {
    test(`Scenario: ${scenario}`, async () => {
      const since = serverNow();
      const round = await approvalRound(c, base());
      const result = await retryLeg(c, base(), round.requestState, answer);
      assert.ok(!result.isError, texts(result));
      assert.deepEqual(RequestHumanOutputSchema.parse(result.structuredContent), { status: "not_sent", reason });
      assert.match(texts(result), /not sent/i);
      await assertNothingCreatedFor(c, MV, since);
    });
  }

  test("Scenario: Forged or expired approval state (forged and altered; expired: package test)", async () => {
    const since = serverNow();
    const round = await approvalRound(c, base());
    const state = round.requestState!;
    const tampered = state.slice(0, -2) + (state.endsWith("AA") ? "BB" : "AA");
    const swapped = state.split(".").reverse().join(".");
    for (const bad of [tampered, swapped, "v1.e30.AAAA", "not-a-state"]) {
      await assert.rejects(retryLeg(c, base(), bad, accept(QUESTION)), assertInvalidState, `state ${bad.slice(0, 12)}… was not refused`);
    }
    // The genuine state presented after fifteen minutes needs the server's
    // clock: apps/mcp/test/request-human.test.ts "Scenario: Forged or expired approval state".
    await assertNothingCreatedFor(c, MV, since);
  });

  test("Scenario: Approval state replayed with changed arguments", async () => {
    const since = serverNow();
    const round = await approvalRound(c, base());
    for (const changed of [base({ bid_minor: 3300 }), base({ to: "sim-ol-6a23" }), base({ expires_at: expiresIn(9 * 3600) })]) {
      const result = await retryLeg(c, changed, round.requestState, accept(QUESTION));
      assert.equal(errorOf(result).code, "conflict");
    }
    const missing = await retryLeg(c, base(), undefined, accept(QUESTION));
    assert.equal(errorOf(missing).code, "conflict", "a retry without state is a conflict too");
    await assertNothingCreatedFor(c, MV, since);
    await assertNothingCreatedFor(c, "sim-ol-6a23", since);
  });

  test("Scenario: Client on an older revision", async () => {
    const since = serverNow();
    let elicited = false;
    const legacy = await legacyClient(() => {
      elicited = true;
    });
    try {
      assert.equal(legacy.client.getProtocolEra(), "legacy");
      const result = await legacy.client.callTool({ name: "request_human", arguments: base() }, { timeout: 30_000 });
      assert.equal(result.isError, true);
      const text = result.content.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("\n");
      assert.match(text, /2026-07-28/);
      assert.match(text, /MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude/);
      assert.match(text, /nothing was created/i);
      assert.equal(elicited, false, "the 2025-era client is never asked");
    } finally {
      await legacy.close();
    }
    await assertNothingCreatedFor(c, MV, since);
  });

  // ---- Approval covers the validated manifest ---------------------------------

  test("Scenario: Edit turns the question into a push-poll", async () => {
    const since = serverNow();
    const round = await approvalRound(c, base());
    const result = await retryLeg(c, base(), round.requestState, accept(PUSH_POLL));
    const error = errorOf(result);
    assert.equal(error.code, "forbidden_content");
    assert.equal(error.stage, "content");
    await assertNothingCreatedFor(c, MV, since);
  });

  test("an edit is re-validated as a whole: an accepted edit that is empty is schema_invalid and creates nothing", async () => {
    const since = serverNow();
    const round = await approvalRound(c, base());
    const result = await retryLeg(c, base(), round.requestState, accept("   "));
    assert.equal(errorOf(result).code, "schema_invalid");
    await assertNothingCreatedFor(c, MV, since);
  });

  test("Scenario: Options shown with the question (the approval message; stored values: package test)", async () => {
    // sim-ep-5c07 accepts opinion (net 800 → gross 1000); first leg only, nothing created.
    const EP = "sim-ep-5c07";
    const since = serverNow();
    const options = [
      { id: "short", label: "Short sentences, «simple» words" },
      { id: "rich", label: "Richer vocabulary (é, 中文)" },
    ];
    const pollArgs = manifest(EP, "opinion", 1100, "Which style suits five-year-olds better?", { format: "poll", options, expires_at: expiresIn(3 * 86_400) });
    const poll = await approvalRound(c, pollArgs);
    const pollMessage = poll.inputRequests!["approval"]!.params.message;
    for (const o of options) assert.ok(pollMessage.includes(o.label), `the approval message does not show the option "${o.label}" verbatim`);
    await retryLeg(c, pollArgs, poll.requestState, { action: "cancel" });

    const scaleArgs = manifest(EP, "opinion", 1100, "How well does this book suit five-year-olds?", { format: "single_field", scale: { min: 1, max: 7 }, expires_at: expiresIn(3 * 86_400) });
    const scaled = await approvalRound(c, scaleArgs);
    const scaleMessage = scaled.inputRequests!["approval"]!.params.message;
    assert.match(scaleMessage, /\b1\b[^\n]*\b7\b/, "the approval message does not show the scale (1 to 7)");
    await retryLeg(c, scaleArgs, scaled.requestState, { action: "cancel" });
    // "the request created on accept holds exactly those values": check_requests
    // does not return options or scale; apps/mcp/test/request-human.test.ts.
    await assertNothingCreatedFor(c, EP, since);
  });

  test("Scenario: Shape outside this change", async () => {
    const since = serverNow();
    const shapes: [string, Record<string, unknown>, RegExp][] = [
      ["audience panel_sample", base({ audience: "panel_sample" }), /audience/],
      ["audience role_qualified_first_to_accept", base({ audience: "role_qualified_first_to_accept" }), /audience/],
      ["time shape threaded", base({ time_shape: "threaded" }), /time_shape/],
      ["time shape recurring", base({ time_shape: "recurring" }), /time_shape/],
      ["attachments", base({ attachments: [{ ref: "att-0001", media_type: "application/pdf", size_bytes: 1024 }] }), /attachments/],
    ];
    for (const [label, args, field] of shapes) {
      const raw = await firstLeg(c, args);
      assert.ok(!isInputRequired(raw), `${label}: the approval was shown for a shape this change does not deliver`);
      const error = errorOf(raw);
      assert.equal(error.code, "schema_invalid", `${label} → ${error.code}`);
      assert.match(error.detail ?? "", field, `${label}: the detail does not name the field`);
      assert.match(error.detail ?? "", /\bM[1-9]\b/, `${label}: the detail does not name the milestone that introduces it`);
    }
    await assertNothingCreatedFor(c, MV, since);
  });

  test("Scenario: Client without forms", async () => {
    const since = serverNow();
    const noForms = await principalClient({ forms: false });
    try {
      const raw = await firstLeg(noForms, base());
      assert.ok(!isInputRequired(raw), "a client that cannot show forms was sent the approval");
      assert.equal(raw.isError, true);
      assert.match(texts(raw), /form|elicitation/i, "the error says the approval dialog cannot be shown");
      assert.match(texts(raw), /nothing was created/i);
    } finally {
      await noForms.close();
    }
    await assertNothingCreatedFor(c, MV, since);
  });

  test("the edited text example is accepted by validation (used by request-flows.test.ts)", async () => {
    // Guards the fixture: EDITED must pass the content rules, or the flows
    // test would fail for the wrong reason. First leg only; nothing created.
    const round = await approvalRound(c, base({ question: EDITED }));
    await retryLeg(c, base({ question: EDITED }), round.requestState, { action: "decline" });
    await assertNothingCreatedFor(c, MV, started);
  });
});
