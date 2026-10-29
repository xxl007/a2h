// Contract tests against a live stage that need created requests and the
// simulated personas, driving the real approval round trip with the official
// v2 client and polling check_requests with a bound. Scenarios from
// openspec/changes/m1-protocol-connector/specs/:
//   protocol/request-approval   Accept after editing, Return under a second,
//                               Accepted approval replayed, Principal recorded
//   protocol/request-lifecycle  Legal transitions (observed), Before acceptance,
//                               After acceptance, Answered request, Filter by
//                               status, Unknown id
//   protocol/answer-attestation Display of the reference answer
//   platform/participant-simulation  Prompt answer, Decline, Can't tell,
//                               Marked in discovery and in answers, Verifies
//                               like a real answer (observable part)
//
// Cost on the stage per run (development principal, infra/config.ts D7):
// four requests, about
// €54 of monthly budget committed for a minute (holds), of which about €54
// stays committed as cleared amounts: prompt €7.75, slow €8.88, can't tell
// €37.50; the decline releases its hold. The slow and can't-tell flows are
// skipped, with the reason, when they would leave the owner less than
// OWNER_HEADROOM (contract/a2h.ts) on the stage; the whole file is skipped
// the same way when even the prompt and decline flows would.
//
// Persona delays (seed): prompt 20 s, decline 15 s, can't tell 30 s, slow
// accepts at 25 s and answers at 100 s; the worker's dispatcher adds up to
// 5 s. Bounds below allow for an Aurora resume (about 15 s) on top.
// Run: A2H_MCP_URL=http://<alb>/pr-<n>/mcp pnpm --filter @a2h/tests contract
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { answerEnvelopeSchemaFor, REQUEST_ID_PATTERN, RequestHumanOutputSchema, type CheckedRequest, type RequestHumanOutput } from "@a2h/protocol";
import {
  accept,
  approvalRound,
  budgetGuard,
  checkOne,
  errorOf,
  grossReserve,
  listSince,
  manifest,
  personaDelay,
  principalClient,
  retryLeg,
  seeded,
  serverNow,
  texts,
  until,
  untilStatusNot,
  type A2hClient,
  type Args,
  type InputRequiredRound,
} from "./a2h.ts";

const FEE_PERCENT = 20; // checked live by discovery.test.ts "Gross reserve with fee metadata"

// Prompt persona, cheapest paid lane: opinion, net 600 → gross 750, latency 4 h.
const JW = "sim-jw-9e48";
const JW_OPTIONS = [
  { id: "harbourside", label: "Route A along the harbourside" },
  { id: "stokes-croft", label: "Route B through Stokes Croft" },
];
const JW_QUESTION = "Which of these two routes into central Bristol feels safer to cycle at rush hour?";
const JW_EDITED = "Which of these two routes feels safer to cycle at 8 am on a weekday? (é, «quotes», 中文)";
// Decline persona: judgment, net 1800 → gross 2250.
const DM = "sim-dm-7b80";
// Slow persona, not identity-verified: opinion, net 700 → gross 875, latency 24 h.
const CF = "sim-cf-4c5e";
// Can't-tell persona: verification (a verdict-bearing intent), net 3000 → gross 3750.
const AG = "sim-ag-3b62";

const SECOND = 1000;
/** Persona delay + dispatcher (5 s) + polling + an Aurora resume, with room to spare. */
const bound = (handle: string, factor = 1) => (personaDelay(handle) * factor + 60) * SECOND;

interface Sent {
  args: Args;
  round: InputRequiredRound;
  result: CallToolResult;
  out: RequestHumanOutput;
  retryMs: number;
}

describe("request flows with the simulated personas (live)", async () => {
  let c: A2hClient;
  const start = serverNow();
  // Decided before any test runs, so a skipped flow is reported as skipped.
  const guardClient = await principalClient();
  const baseGuard = await budgetGuard(guardClient, 800 + 2250, 3);
  const extraGuard = baseGuard || (await budgetGuard(guardClient, 800 + 2250 + 900 + 3750, 5));
  await guardClient.close();

  let prompt: Sent | undefined;
  let declineId: string | undefined;
  let slowId: string | undefined;
  let cantTellId: string | undefined;

  before(async () => {
    c = await principalClient();
  });
  after(async () => {
    await c?.close();
  });

  async function send(args: Args, approved: string): Promise<Sent> {
    const round = await approvalRound(c, args);
    const t0 = performance.now();
    const result = await retryLeg(c, args, round.requestState, accept(approved));
    const retryMs = performance.now() - t0;
    assert.ok(!result.isError, `request_human to ${String(args["to"])} failed: ${texts(result)}`);
    return { args, round, result, out: RequestHumanOutputSchema.parse(result.structuredContent), retryMs };
  }

  function promptSent(): Sent {
    assert.ok(prompt, "the prompt request was not created (see 'Scenario: Accept after editing')");
    return prompt;
  }

  function need(id: string | undefined, what: string): string {
    assert.ok(id, `the ${what} request was not created (see 'sends one request to each persona')`);
    return id;
  }

  // ---- request-approval: the created request ---------------------------------

  test("Scenario: Accept after editing", { skip: baseGuard }, async () => {
    const args = manifest(JW, "opinion", 800, JW_QUESTION, { format: "poll", options: JW_OPTIONS });
    prompt = await send(args, JW_EDITED);
    assert.equal(prompt.round.inputRequests!["approval"]!.params.requestedSchema.properties["question"]!["default"], JW_QUESTION);
    assert.equal(prompt.out.status, "sent");
    const mine = (await listSince(c, start)).filter((r) => r.handle === JW);
    assert.deepEqual(mine.map((r) => r.request_id), [prompt.out.request_id], "exactly one request was created by the accept");
    // "byte-identical to the edited text": check_requests does not return the
    // question, so the stored bytes are compared in
    // apps/mcp/test/request-human.test.ts "Scenario: Accept after editing".
  });

  test("Scenario: Return under a second", { skip: baseGuard }, () => {
    const p = promptSent();
    assert.ok(p.retryMs < 1000, `the accepting call took ${Math.round(p.retryMs)} ms`);
    assert.match(p.out.request_id!, REQUEST_ID_PATTERN);
    assert.equal(p.out.status, "sent");
    assert.ok(p.out.eta && Date.parse(p.out.eta) > Date.parse(p.out.deliver_at!), "an ETA after delivery");
    assert.equal(p.out.held_minor, 800, "held = gross bid");
    assert.equal(p.out.currency, "EUR");
    assert.match(texts(p.result), new RegExp(p.out.request_id!));
  });

  test("Scenario: Before acceptance", { skip: baseGuard }, async () => {
    const r = await checkOne(c, promptSent().out.request_id!);
    // The persona acts 20 s after delivery: this check comes well before.
    assert.equal(r.status, "sent", "checked before the persona acted");
    assert.equal(r.handle, JW);
    assert.equal(r.participant_label, undefined, "no display label before acceptance");
    assert.equal(r.identity_verified, undefined, "no verification status before acceptance");
    assert.equal(r.held_minor, 800);
    assert.equal(r.hold_status, "held");
    assert.ok(!JSON.stringify(r).includes(seeded(JW).display_label.split(" ")[0]!), "no name anywhere");
  });

  test("Scenario: Accepted approval replayed", { skip: baseGuard }, async () => {
    // Single-use approval (requests.approval_nonce, PR #32): a replay creates nothing.
    const p = promptSent();
    const before = await checkOne(c, p.out.request_id!);
    const replay = await retryLeg(c, p.args, p.round.requestState, accept(JW_EDITED));
    const mine = (await listSince(c, start)).filter((r) => r.handle === JW);
    const after = await checkOne(c, p.out.request_id!);
    assert.equal(after.held_minor, before.held_minor, "the first request is unchanged");
    assert.equal(after.transitions.sent_at, before.transitions.sent_at, "the first request is unchanged");
    assert.deepEqual(
      mine.map((r) => r.request_id),
      [p.out.request_id],
      `a second request (and hold) was created by the replay: ${replay.isError ? "" : JSON.stringify(replay.structuredContent)}`,
    );
    assert.equal(errorOf(replay).code, "conflict");
  });

  test("Scenario: Filter by status", { skip: baseGuard }, async () => {
    const sent = await listSince(c, new Date(start.getTime() - 7 * 86_400 * SECOND), "sent");
    assert.ok(sent.every((r) => r.status === "sent"), `statuses: ${JSON.stringify(sent.map((r) => r.status))}`);
    const p = promptSent();
    const current = await checkOne(c, p.out.request_id!);
    if (current.status === "sent") assert.ok(sent.some((r) => r.request_id === p.out.request_id), "the request just sent is listed");
    // "belongs to the calling principal": a stage has one principal; the
    // cross-principal case is apps/mcp/test/check-requests.test.ts.
  });

  test("sends one request to each other persona (decline, slow, can't tell)", { skip: baseGuard }, async (t) => {
    const declined = await send(manifest(DM, "judgment", 2250, "Is this Year 9 algebra worksheet pitched at the right level?"), "Is this Year 9 algebra worksheet pitched at the right level?");
    declineId = declined.out.request_id;
    if (extraGuard) {
      t.diagnostic(`slow and can't-tell flows not sent: ${extraGuard}`);
      return;
    }
    const slowQ = "Which of these two venues feels better value for a September wedding?";
    const slow = await send(manifest(CF, "opinion", 900, slowQ, { format: "poll", options: [{ id: "barn", label: "The barn" }, { id: "manor", label: "The manor" }] }), slowQ);
    slowId = slow.out.request_id;
    const ctQ = "Does this invoice layout meet the UK VAT invoice requirements?";
    const ct = await send(manifest(AG, "verification", 3750, ctQ), ctQ);
    cantTellId = ct.out.request_id;
  });

  // ---- participant-simulation and lifecycle: the personas act ----------------

  let promptDone: CheckedRequest | undefined;

  test("Scenario: Prompt answer", { skip: baseGuard }, async () => {
    const p = promptSent();
    const r = await untilStatusNot(c, p.out.request_id!, ["sent", "accepted"], bound(JW));
    promptDone = r;
    assert.equal(r.status, "answered");
    assert.ok(r.transitions.accepted_at, "accepted first");
    const tookS = (Date.parse(r.transitions.answered_at!) - Date.parse(r.transitions.sent_at)) / SECOND;
    assert.ok(tookS <= personaDelay(JW) + 60, `answered ${tookS} s after sending (delay ${personaDelay(JW)} s)`);
    const envelope = answerEnvelopeSchemaFor("opinion").parse(r.answer);
    const body = envelope.body as { choice?: string };
    assert.ok(JW_OPTIONS.some((o) => o.id === body.choice), `a body matching the request's intent and options: ${JSON.stringify(envelope.body)}`);
  });

  function answered(): CheckedRequest {
    assert.ok(promptDone, "the prompt request was not answered (see 'Scenario: Prompt answer')");
    return promptDone;
  }

  test("Scenario: Legal transitions (observed: sent → accepted → answered; sent → declined below)", { skip: baseGuard }, () => {
    const r = answered();
    const { sent_at, accepted_at, answered_at, ...rest } = r.transitions;
    assert.ok(Date.parse(sent_at) <= Date.parse(accepted_at!) && Date.parse(accepted_at!) <= Date.parse(answered_at!), JSON.stringify(r.transitions));
    assert.deepEqual(rest, {}, "no other transition");
    // One event row per transition, illegal transitions and the expiry moves:
    // packages/protocol lifecycle.test.ts, packages/db constraints.test.ts,
    // apps/worker simulate.test.ts and expire.test.ts.
  });

  test("Scenario: Answered request", { skip: baseGuard }, () => {
    const r = answered();
    const a = r.answer!;
    for (const field of ["body", "confidence", "answered_personally", "signed_at", "key_id", "signature"] as const) {
      assert.notEqual(a[field], undefined, `the envelope carries ${field}`);
    }
    assert.equal(a.request_id, r.request_id);
    assert.equal(a.answered_personally, true);
    assert.ok(a.confidence >= 1 && a.confidence <= 5);
    const reserve = grossReserve(JW, "opinion", FEE_PERCENT);
    assert.ok(r.cleared_minor !== undefined && reserve <= r.cleared_minor && r.cleared_minor <= 800, `reserve ${reserve} ≤ cleared ${r.cleared_minor} ≤ bid 800`);
    assert.equal(r.hold_status, "captured");
  });

  test("Scenario: Marked in discovery and in answers (answer side)", { skip: baseGuard }, () => {
    const r = answered();
    assert.match(r.handle, /^sim-/);
    assert.match(r.participant_label ?? "", / \(simulated\)$/, "the label ends with (simulated)");
    assert.equal(r.simulated, true, "the answer carries simulated: true");
  });

  test("Scenario: Verifies like a real answer (observable part)", { skip: baseGuard }, () => {
    // check_requests shows an answer only after verifying its Ed25519
    // signature over the recomputed canonical payload with the key named by
    // key_id; the public key is not exposed, so from outside the test checks
    // that a shown answer is a complete, well-formed signed envelope. The
    // verification itself: apps/worker/test/simulate.test.ts "Scenario:
    // Verifies like a real answer", apps/mcp/test/check-requests.test.ts.
    const a = answered().answer!;
    assert.equal(Buffer.from(a.signature, "base64").length, 64, "an Ed25519 signature is 64 bytes");
    assert.match(a.key_id, /\S/);
    assert.ok(!Number.isNaN(Date.parse(a.signed_at)));
  });

  test("Scenario: Display of the reference answer", { skip: baseGuard }, () => {
    const r = answered();
    const a = r.answer!;
    assert.equal(r.answer_display?.signature, `a2h:sig:…${a.signature.slice(-4)}`);
    const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})T/.exec(a.signed_at)!;
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
    assert.equal(r.answer_display?.citation, `reviewed by J.W., ${Number(d)} ${month} ${y}`, "James Whitlock (simulated)");
    assert.equal(r.answer_display?.verification_notice, undefined, "sim-jw-9e48 is identity-verified: no notice");
  });

  test("Scenario: Decline", { skip: baseGuard }, async () => {
    const id = need(declineId, "decline");
    const r = await untilStatusNot(c, id, ["sent"], bound(DM));
    assert.equal(r.status, "declined");
    assert.ok(r.transitions.declined_at);
    assert.equal(r.transitions.accepted_at, undefined);
    assert.equal(r.hold_status, "released", "nothing is charged: the hold is released");
    assert.equal(r.cleared_minor, undefined);
    assert.equal(r.answer, undefined);
    // "with a decline reason": check_requests does not report the reason
    // (the principal sees the category of outcome only); the reason code is
    // asserted in apps/worker/test/simulate.test.ts "Scenario: Decline".
  });

  test("Scenario: After acceptance", { skip: baseGuard || extraGuard }, async () => {
    const id = need(slowId, "slow");
    const r = await untilStatusNot(c, id, ["sent"], bound(CF, 0.25));
    assert.equal(r.status, "accepted", "the slow persona accepts first and answers later");
    assert.equal(r.participant_label, seeded(CF).display_label);
    assert.equal(r.identity_verified, false, "the result says whether the participant is identity-verified");
  });

  test("Scenario: Can't tell", { skip: baseGuard || extraGuard }, async () => {
    const id = need(cantTellId, "can't tell");
    const r = await untilStatusNot(c, id, ["sent", "accepted"], bound(AG));
    assert.equal(r.status, "answered");
    const envelope = answerEnvelopeSchemaFor("verification").parse(r.answer);
    assert.equal((envelope.body as { verdict: string }).verdict, "cant_tell");
    assert.equal(envelope.answered_personally, true);
    assert.equal(r.simulated, true);
  });

  test("slow persona: answers at its delay, with the not-yet-verified notice", { skip: baseGuard || extraGuard }, async () => {
    const id = need(slowId, "slow");
    const r = await untilStatusNot(c, id, ["sent", "accepted"], bound(CF));
    assert.equal(r.status, "answered");
    assert.ok(r.answer_display?.verification_notice, "the principal is told the participant is not yet identity-verified");
    const reserve = grossReserve(CF, "opinion", FEE_PERCENT);
    assert.ok(r.cleared_minor !== undefined && reserve <= r.cleared_minor && r.cleared_minor <= 900);
  });

  test("Scenario: Unknown id", async () => {
    const known = new Set((await listSince(c, new Date(Date.UTC(2026, 0, 1)))).map((r) => r.request_id));
    const id = await until("an unused request id", 5 * SECOND, () => {
      const candidate = `A2H-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;
      return Promise.resolve(known.has(candidate) ? undefined : candidate);
    }, 0);
    const result = (await c.client.callTool({ name: "check_requests", arguments: { request_id: id } }));
    const error = errorOf(result);
    assert.equal(error.code, "not_found");
    assert.deepEqual(Object.keys(result.structuredContent ?? {}), ["error"], "nothing else is revealed");
  });

  test("Scenario: Principal recorded (observable part)", { skip: baseGuard }, async () => {
    // The request is the calling principal's: it lists and checks under this
    // connection. That another principal gets not_found needs a second
    // principal, which a stage does not have (D7):
    // apps/mcp/test/request-human.test.ts "Scenario: Principal recorded".
    const r = await checkOne(c, promptSent().out.request_id!);
    assert.equal(r.request_id, promptSent().out.request_id);
  });
});
