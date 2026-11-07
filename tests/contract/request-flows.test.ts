// Contract tests against a live stage that need sent requests and the
// simulated personas: request_human returns the link, the QA principal
// chooses Send on the hosted approval page (tests/lib/approval-page.ts,
// m2-approval-page), and check_requests is polled with a bound. Scenarios:
//   protocol/request-approval   Send on the page, Accept after editing,
//                               Decision replayed, Principal recorded
//   protocol/request-lifecycle  Legal transitions, Illegal transition,
//                               Idempotent replay, Agent cannot approve,
//                               Awaiting approval, Not sent, Before
//                               acceptance, After acceptance, Answered
//                               request, Filter by status, Unknown id
//   protocol/answer-attestation Display of the reference answer
//   platform/participant-simulation  Prompt answer, Decline, Can't tell,
//                               Marked in discovery and in answers, Verifies
//                               like a real answer (observable part)
// The expiries (Expiry by the platform, Approval link expiry by the
// platform, Silent until expiry) take over fifteen minutes since the link
// lasts at least that long: approval-expiry.test.ts.
//
// Cost on the stage per run (the QA principal's policy, infra/config.ts):
// four sent requests, about €77 of monthly budget held, of which about €54
// stays committed as cleared amounts (prompt €7.75, slow €8.88, can't tell
// €37.50); the decline releases its hold. The slow and can't-tell flows are
// skipped, with the reason, when they would leave the owner less than
// OWNER_HEADROOM (contract/a2h.ts) on the stage; the whole file is skipped
// the same way when even the prompt and decline flows would.
//
// Persona delays (seed): prompt 20 s, decline 15 s, can't tell 30 s, slow
// accepts at 25 s and answers at 100 s; the worker's dispatcher adds up to
// 5 s. Bounds below allow for an Aurora resume (about 15 s) on top.
// Handles: sim-jw-9e48, sim-dm-7b80, sim-cf-4c5e, sim-ag-3b62 (no other file
// run at the same time checks that nothing was created for them).
// Run: A2H_MCP_URL=… A2H_TOKEN=… A2H_SESSION_STATE=… pnpm --filter @a2h/tests contract
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Browser, Page } from "@playwright/test";
import { answerEnvelopeSchemaFor, REQUEST_ID_PATTERN, type CheckedRequest } from "@a2h/protocol";
import {
  budgetGuard,
  checkOne,
  errorOf,
  grossReserve,
  listSince,
  manifest,
  personaDelay,
  principalClient,
  requestAwaiting,
  seeded,
  serverNow,
  until,
  untilStatusNot,
  type A2hClient,
  type Args,
  type Awaiting,
} from "./a2h.ts";
import { closePage, decide, launch, mainText, openLink, PAGE, pageAs, pageSkip } from "../lib/approval-page.ts";

const FEE_PERCENT = 20; // checked live by discovery.test.ts "Gross reserve with fee metadata"

// Prompt persona, cheapest paid lane: opinion, net 600 → gross 750, latency 4 h.
const JW = "sim-jw-9e48";
const JW_OPTIONS = [
  { id: "harbourside", label: "Route A along the harbourside" },
  { id: "stokes-croft", label: "Route B through Stokes Croft" },
];
const JW_QUESTION = "Which of these two routes into central Bristol feels safer to cycle at rush hour?";
const JW_EDITED = "Which of these two routes feels safer to cycle at 8 am on a weekday? (é, «quotes», 中文)\nSecond line.";
// Decline persona: judgment, net 1800 → gross 2250.
const DM = "sim-dm-7b80";
// Slow persona, not identity-verified: opinion, net 700 → gross 875, latency 24 h.
const CF = "sim-cf-4c5e";
// Can't-tell persona: verification (a verdict-bearing intent), net 3000 → gross 3750.
const AG = "sim-ag-3b62";

const SECOND = 1000;
/** Persona delay + dispatcher (5 s) + polling + an Aurora resume, with room to spare. */
const bound = (handle: string, factor = 1) => (personaDelay(handle) * factor + 60) * SECOND;
const PAGE_A = pageSkip("a");

interface Sent extends Awaiting {
  args: Args;
  /** The page's heading after Send. */
  outcome: string;
}

describe("request flows with the simulated personas (live)", { skip: PAGE_A }, async () => {
  let c: A2hClient;
  let browser: Browser;
  const start = serverNow();
  // Decided before any test runs, so a skipped flow is reported as skipped.
  let baseGuard: string | false = false;
  let extraGuard: string | false = false;
  if (!PAGE_A) {
    const guardClient = await principalClient();
    baseGuard = await budgetGuard(guardClient, 800 + 2250, 3);
    extraGuard = baseGuard || (await budgetGuard(guardClient, 800 + 2250 + 900 + 3750, 5));
    await guardClient.close();
  }

  let prompt: Sent | undefined;
  let declineId: string | undefined;
  let slowId: string | undefined;
  let cantTellId: string | undefined;

  before(async () => {
    c = await principalClient();
    browser = await launch();
  });
  after(async () => {
    await c?.close();
    await browser?.close();
  });

  /** request_human, then Send on the page as principal A (optionally with an edited question). */
  async function send(args: Args, question?: string): Promise<Sent> {
    const awaiting = await requestAwaiting(c, args);
    const page = await pageAs(browser, "a");
    try {
      assert.equal(await openLink(page, awaiting.out.approval_url), PAGE.awaiting, `${awaiting.out.request_id}: the page awaits a decision`);
      const d = await decide(page, "send", question !== undefined ? { question } : {});
      assert.equal(d.heading, PAGE.sent, `${awaiting.out.request_id} to ${String(args["to"])}: Send did not send (${JSON.stringify(d.alerts.map((a) => a.slice(0, 80)))})`);
      return { ...awaiting, args, outcome: d.heading };
    } finally {
      await closePage(page);
    }
  }

  function promptSent(): Sent {
    assert.ok(prompt, "the prompt request was not sent (see 'Scenario: Send on the page')");
    return prompt;
  }

  function need(id: string | undefined, what: string): string {
    assert.ok(id, `the ${what} request was not sent (see 'sends one request to each other persona')`);
    return id;
  }

  // ---- request-approval: Send on the page -------------------------------------

  test("Scenario: Send on the page, Scenario: Accept after editing, Scenario: Decision replayed (two tabs on one link)", { skip: baseGuard }, async () => {
    const args = manifest(JW, "opinion", 800, JW_QUESTION, { format: "poll", options: JW_OPTIONS });
    const awaiting = await requestAwaiting(c, args);
    const id = awaiting.out.request_id;
    // Two tabs of the principal's browser on the same link, both awaiting a decision.
    const first = await pageAs(browser, "a");
    let second: Page | undefined;
    try {
      assert.equal(await openLink(first, awaiting.out.approval_url), PAGE.awaiting);
      second = await first.context().newPage();
      assert.equal(await openLink(second, awaiting.out.approval_url), PAGE.awaiting);

      // Accept after editing: Send with the edited question; the page shows the question as sent.
      const d = await decide(first, "send", { question: JW_EDITED });
      assert.equal(d.heading, PAGE.sent, JSON.stringify(d.alerts.map((a) => a.slice(0, 80))));
      assert.match(await mainText(first), /€8\.00 is held/, "the gross bid is held");
      const asSent = await first.locator("main p").filter({ hasText: "Second line." }).innerText();
      assert.equal(Buffer.from(asSent).toString("hex"), Buffer.from(JW_EDITED).toString("hex"), "the question as sent is byte-identical to the edit");
      prompt = { ...awaiting, args, outcome: d.heading };
      const afterSend = await checkOne(c, id);
      assert.equal(afterSend.status, "sent");
      assert.equal(afterSend.held_minor, 800, "held = gross bid");
      assert.equal(afterSend.hold_status, "held");

      // Decision replayed: the second tab's Send sees the decision already taken; nothing changes.
      const replay = await decide(second, "send");
      assert.equal(replay.heading, PAGE.alreadySent);
      assert.match(await mainText(second), /Nothing more can be decided on this page\./);
      const afterReplay = await checkOne(c, id);
      assert.equal(afterReplay.held_minor, afterSend.held_minor, "no second hold");
      assert.equal(afterReplay.transitions.sent_at, afterSend.transitions.sent_at, "one transition to sent");
      // Reopening the link: already decided, and still the edited text (the page reads the stored question).
      assert.equal(await openLink(second, awaiting.out.approval_url), PAGE.alreadySent);
      assert.equal(await second.locator("main p").filter({ hasText: "Second line." }).innerText(), JW_EDITED);
    } finally {
      await closePage(first);
    }
    const mine = (await listSince(c, start)).filter((r) => r.handle === JW);
    assert.deepEqual(mine.map((r) => r.request_id), [id], "exactly one request to the participant");
    // The stored bytes themselves: packages/db/test/approval.test.ts and apps/web/test/e2e/approval.spec.ts.
  });

  test("Scenario: Before acceptance", async () => {
    const r = await checkOne(c, promptSent().out.request_id);
    // The persona acts 20 s after delivery: this check comes well before.
    assert.equal(r.status, "sent", "checked before the persona acted");
    assert.equal(r.handle, JW);
    assert.equal(r.participant_label, undefined, "no display label before acceptance");
    assert.equal(r.identity_verified, undefined, "no verification status before acceptance");
    assert.equal(r.held_minor, 800);
    assert.equal(r.hold_status, "held");
    assert.equal(r.approval_url, undefined, "a sent request no longer carries the link");
    assert.ok(!JSON.stringify(r).includes(seeded(JW).display_label.split(" ")[0]!), "no name anywhere");
  });

  test("Scenario: Filter by status (sent, and awaiting_approval)", async () => {
    const weekAgo = new Date(start.getTime() - 7 * 86_400 * SECOND);
    for (const status of ["sent", "awaiting_approval"]) {
      const listed = await listSince(c, weekAgo, status);
      assert.ok(listed.every((r) => r.status === status), `${status}: ${JSON.stringify(listed.map((r) => r.status))}`);
    }
    const p = promptSent();
    const current = await checkOne(c, p.out.request_id);
    if (current.status === "sent") assert.ok((await listSince(c, weekAgo, "sent")).some((r) => r.request_id === p.out.request_id), "the request just sent is listed");
    // "belongs to the calling principal": contract/connector-authorization.test.ts and adversarial case A7.
  });

  test("sends one request to each other persona on the page (decline, slow, can't tell)", { skip: baseGuard }, async (t) => {
    const q = "Is this Year 9 algebra worksheet pitched at the right level?";
    declineId = (await send(manifest(DM, "judgment", 2250, q))).out.request_id;
    if (extraGuard) {
      t.diagnostic(`slow and can't-tell flows not sent: ${extraGuard}`);
      return;
    }
    const slowQ = "Which of these two venues feels better value for a September wedding?";
    slowId = (await send(manifest(CF, "opinion", 900, slowQ, { format: "poll", options: [{ id: "barn", label: "The barn" }, { id: "manor", label: "The manor" }] }))).out.request_id;
    const ctQ = "Does this invoice layout meet the UK VAT invoice requirements?";
    cantTellId = (await send(manifest(AG, "verification", 3750, ctQ))).out.request_id;
  });

  // ---- request-lifecycle: the request before it is sent --------------------------

  test("Scenario: Awaiting approval, Scenario: Not sent, Scenario: Illegal transition (not_sent → sent), Scenario: Idempotent replay (Don't send twice)", async () => {
    // A request to the can't-tell persona that is never sent (no cost).
    const awaiting = await requestAwaiting(c, manifest(AG, "verification", 3750, "Does this shelf label meet the UK unit pricing rules?"));
    const id = awaiting.out.request_id;
    const r = await checkOne(c, id);
    assert.equal(r.status, "awaiting_approval");
    assert.equal(r.approval_url, awaiting.out.approval_url, "check_requests shows the same link again (derived token, design D2)");
    assert.equal(r.approval_expires_at, awaiting.out.approval_expires_at);
    assert.equal(r.held_minor, undefined, "no held amount");
    assert.equal(r.hold_status, "none");

    const t1 = await pageAs(browser, "a");
    try {
      const t2 = await t1.context().newPage();
      const t3 = await t1.context().newPage();
      for (const p of [t1, t2, t3]) assert.equal(await openLink(p, awaiting.out.approval_url), PAGE.awaiting);
      assert.equal((await decide(t1, "dont_send")).heading, PAGE.notSent);
      const notSent = await checkOne(c, id);
      assert.equal(notSent.status, "not_sent");
      assert.equal(notSent.reason, "declined");
      assert.equal(notSent.held_minor, undefined, "no held amount");
      assert.equal(notSent.approval_url, undefined, "the link is gone once decided");
      // not_sent → sent: refused; the page says it was not sent.
      assert.equal((await decide(t2, "send")).heading, PAGE.alreadyNotSent);
      // The same transition again: nothing changes, no second event.
      assert.equal((await decide(t3, "dont_send")).heading, PAGE.alreadyNotSent);
      const after = await checkOne(c, id);
      assert.equal(after.status, "not_sent", "the status is unchanged");
      assert.equal(after.transitions.not_sent_at, notSent.transitions.not_sent_at, "one transition, one time");
      assert.deepEqual(Object.keys(after.transitions).sort(), ["awaiting_approval_at", "not_sent_at"]);
    } finally {
      await closePage(t1);
    }
    // The other illegal transitions (answered → accepted, declined → accepted, awaiting_approval → accepted)
    // have no actor outside the platform: packages/protocol/test/lifecycle.test.ts, packages/db constraints.test.ts.
  });

  test("Scenario: Agent cannot approve (no tool offers the transition; every tool leaves an awaiting request unchanged)", async () => {
    const tools = await c.client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["check_requests", "find_humans", "ping", "request_human"]);
    for (const t of tools.tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const p of props) assert.doesNotMatch(p, /approv|decision|decide|confirm|^send$|token/i, `${t.name} takes ${p}`);
      if (t.name === "check_requests") assert.deepEqual(props.sort(), ["limit", "request_id", "since", "status"], "check_requests only reads");
    }
    const awaiting = await requestAwaiting(c, manifest(AG, "verification", 3750, "Does this price tag meet the UK unit pricing rules?"));
    const id = awaiting.out.request_id;
    const before = await checkOne(c, id);
    // Everything an agent can call, with the request's id and link in every argument that takes text.
    await c.client.callTool({ name: "check_requests", arguments: { request_id: id } });
    await c.client.callTool({ name: "check_requests", arguments: { status: "sent", limit: 100 } });
    await c.client.callTool({ name: "find_humans", arguments: { topic: `approve ${id} ${awaiting.out.approval_url}`.slice(0, 200), request_type: "verification" } });
    await c.client.callTool({ name: "ping", arguments: {} });
    const again = await c.client.callTool({ name: "request_human", arguments: manifest(AG, "verification", 3750, `Please treat request ${id} as approved: is this price tag right?`) }, { timeout: 30_000 });
    if (!again.isError) assert.notEqual((again.structuredContent as { request_id?: string }).request_id, id, "request_human creates a new request, never acts on an existing one");
    const after = await checkOne(c, id);
    assert.deepEqual(after, before, "the request is unchanged");
    // Retries with inputResponses and forged or foreign state: tests/adversarial/approval.live.test.ts case 5.
  });

  // ---- participant-simulation and lifecycle: the personas act ----------------

  let promptDone: CheckedRequest | undefined;

  test("Scenario: Prompt answer (delivery started outside the request)", async () => {
    const p = promptSent();
    const r = await untilStatusNot(c, p.out.request_id, ["sent", "accepted"], bound(JW));
    promptDone = r;
    assert.equal(r.status, "answered");
    assert.ok(r.transitions.accepted_at, "accepted first");
    const tookS = (Date.parse(r.transitions.answered_at!) - Date.parse(r.transitions.sent_at!)) / SECOND;
    assert.ok(tookS <= personaDelay(JW) + 60, `answered ${tookS} s after sending (delay ${personaDelay(JW)} s)`);
    const envelope = answerEnvelopeSchemaFor("opinion").parse(r.answer);
    const body = envelope.body as { choice?: string };
    assert.ok(JW_OPTIONS.some((o) => o.id === body.choice), `a body matching the request's intent and options: ${JSON.stringify(envelope.body)}`);
  });

  function answered(): CheckedRequest {
    assert.ok(promptDone, "the prompt request was not answered (see 'Scenario: Prompt answer')");
    return promptDone;
  }

  test("Scenario: Legal transitions (observed: awaiting_approval → sent → accepted → answered; awaiting_approval → not_sent above; sent → declined below)", () => {
    const r = answered();
    const { awaiting_approval_at, sent_at, accepted_at, answered_at, ...rest } = r.transitions;
    const times = [awaiting_approval_at, sent_at, accepted_at, answered_at].map((x) => Date.parse(x!));
    assert.ok(times.every((t, i) => !Number.isNaN(t) && (i === 0 || times[i - 1]! <= t)), JSON.stringify(r.transitions));
    assert.deepEqual(rest, {}, "no other transition");
    // One event row per transition: packages/protocol lifecycle.test.ts, packages/db constraints.test.ts,
    // apps/worker simulate.test.ts and expire.test.ts.
  });

  test("Scenario: Answered request", () => {
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

  test("Scenario: Marked in discovery and in answers (answer side)", () => {
    const r = answered();
    assert.match(r.handle, /^sim-/);
    assert.match(r.participant_label ?? "", / \(simulated\)$/, "the label ends with (simulated)");
    assert.equal(r.simulated, true, "the answer carries simulated: true");
  });

  test("Scenario: Verifies like a real answer (observable part)", () => {
    // check_requests shows an answer only after verifying its Ed25519 signature; from outside the test
    // checks that a shown answer is a complete, well-formed signed envelope. The verification itself:
    // apps/worker/test/simulate.test.ts, apps/mcp/test/check-requests.test.ts.
    const a = answered().answer!;
    assert.equal(Buffer.from(a.signature, "base64").length, 64, "an Ed25519 signature is 64 bytes");
    assert.match(a.key_id, /\S/);
    assert.ok(!Number.isNaN(Date.parse(a.signed_at)));
  });

  test("Scenario: Display of the reference answer", () => {
    const r = answered();
    const a = r.answer!;
    assert.equal(r.answer_display?.signature, `a2h:sig:…${a.signature.slice(-4)}`);
    const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})T/.exec(a.signed_at)!;
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
    assert.equal(r.answer_display?.citation, `reviewed by J.W., ${Number(d)} ${month} ${y}`, "James Whitlock (simulated)");
    assert.equal(r.answer_display?.verification_notice, undefined, "sim-jw-9e48 is identity-verified: no notice");
  });

  test("Scenario: Decline", async () => {
    const id = need(declineId, "decline");
    const r = await untilStatusNot(c, id, ["sent"], bound(DM));
    assert.equal(r.status, "declined");
    assert.ok(r.transitions.declined_at);
    assert.equal(r.transitions.accepted_at, undefined);
    assert.equal(r.hold_status, "released", "nothing is charged: the hold is released");
    assert.equal(r.cleared_minor, undefined);
    assert.equal(r.answer, undefined);
  });

  test("Scenario: After acceptance", async () => {
    const id = need(slowId, "slow");
    const r = await untilStatusNot(c, id, ["sent"], bound(CF, 0.25));
    assert.equal(r.status, "accepted", "the slow persona accepts first and answers later");
    assert.equal(r.participant_label, seeded(CF).display_label);
    assert.equal(r.identity_verified, false, "the result says whether the participant is identity-verified");
  });

  test("Scenario: Can't tell", async () => {
    const id = need(cantTellId, "can't tell");
    const r = await untilStatusNot(c, id, ["sent", "accepted"], bound(AG));
    assert.equal(r.status, "answered");
    const envelope = answerEnvelopeSchemaFor("verification").parse(r.answer);
    assert.equal((envelope.body as { verdict: string }).verdict, "cant_tell");
    assert.equal(envelope.answered_personally, true);
    assert.equal(r.simulated, true);
  });

  test("slow persona: answers at its delay, with the not-yet-verified notice", async () => {
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

  test("Scenario: Principal recorded (observable part)", async () => {
    // The request is the calling principal's: it lists and checks under this connection. Another
    // principal gets not_found: contract/connector-authorization.test.ts, adversarial case A7.
    const r = await checkOne(c, promptSent().out.request_id);
    assert.equal(r.request_id, promptSent().out.request_id);
    assert.match(r.request_id, REQUEST_ID_PATTERN);
  });
});
