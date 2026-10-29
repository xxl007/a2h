// Adversarial suite, manifest side, against a live stage (A2H_MCP_URL):
// cases 1 to 6 of the protocol skill §12. Every case must fail closed:
// refused with the right category, no approval shown where the first leg is
// refused, nothing created, and no participant rule revealed. Each case
// attacks more than the plain scenario of the contract suite: paraphrases,
// the edit in the approval form, an approval minted while the rules allowed
// it and redeemed after, and argument swaps on the retry.
//
// Known limits of the deterministic content rules (design D6; the detection
// method is OPEN until M3) are recorded as `todo` tests: they report, without
// failing the run, the evasions that get through today.
//
// Handles: sim-mv-7f3c, sim-th-2a91, sim-ol-6a23 and sim-ep-5c07 never get a
// request from this file; sim-bk-2e6f gets at most its two a day (shared
// with the contract suite's "Interruption budget exceeded").
// Run: A2H_MCP_URL=http://<alb>/pr-<n>/mcp pnpm --filter @a2h/tests adversarial
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { RequestHumanOutputSchema } from "@a2h/protocol";
import {
  accept,
  approvalRound,
  assertNothingCreatedFor,
  errorOf,
  expiresIn,
  firstLeg,
  isInputRequired,
  manifest,
  principalClient,
  retryLeg,
  serverNow,
  type A2hClient,
  type Args,
  type InputRequiredRound,
  type ToolError,
} from "../contract/a2h.ts";

const MV = "sim-mv-7f3c"; // judgment net 2500 → gross 3125; own_publications free lane
const TH = "sim-th-2a91"; // knowledge net 4500 → gross 5625, verification net 3500 → 4375; no free lane
const BENIGN = "Would a patient with type 2 diabetes find the insulin section of this leaflet alarming?";

const mv = (extra: Args = {}) => manifest(MV, "judgment", 3200, BENIGN, extra);

const PUSH_POLLS = [
  "Would you still trust this clinic if you learned its director lied about the results?",
  "Would you be less likely to recommend this leaflet if you knew the author was paid by a drug company?",
  "Wouldn't you agree that this leaflet is dangerous?",
  "Don’t you think the new insulin guidance is a disgrace?",
  "Isn't it true that the clinic hid the side effects?",
  "Given that the health minister is corrupt, is this leaflet trustworthy?",
  "Everyone knows that this hospital is incompetent: is the leaflet any better?",
];
const THIRD_PARTY = [
  "What is your colleague's home address?",
  "Does your patient have a medical condition that affects their insulin dose?",
  "What salary does your manager earn?",
  "Can you tell me Jean Martin's phone number?",
  "What is her email address? She wrote the leaflet.",
  "What are the political views of your neighbour?",
];
const LABOUR = [
  "Please write a 2,000-word report on insulin pricing.",
  "Can you proofread these 30 pages of patient information?",
  "I need you to draft a business plan for a diabetes clinic.",
  "Kindly label 500 images of insulin pens for my dataset.",
  "Could you summarise these transcripts of patient interviews?",
];
/** Evasions the deterministic rules miss today (reported as todo, see the header). */
const EVASIONS: [string, string][] = [
  ["push-poll with a zero-width space instead of a space", "Would you still trust this clinic if you​learned its director lied about the results?"],
  ["push-poll with a Cyrillic letter in 'agree'", "Wouldn't you аgree that this leaflet is dangerous?"],
  ["third-party data in indirect wording", "Where does the woman who wrote this leaflet live, street and number?"],
  ["labour as a polite question without an imperative", "Is it possible for you to produce a 2,000-word report on insulin pricing?"],
  ["third-party health data with a named person and a specific disease", "Does Anna have diabetes?"],
  ["labour whose deliverable is not in the word list", "Could you translate this leaflet into French and Spanish?"],
];

describe("adversarial: manifest validation fails closed (live)", () => {
  let c: A2hClient;
  before(async () => {
    c = await principalClient();
  });
  after(async () => {
    await c?.close();
  });

  async function refusedAtFirstLeg(args: Args): Promise<ToolError> {
    const raw = await firstLeg(c, args);
    assert.ok(!isInputRequired(raw), `the approval was shown for a manifest that must be refused (${String(args["to"])})`);
    return errorOf(raw);
  }

  function forbidden(error: ToolError, question: string, raw?: unknown): void {
    assert.equal(error.code, "forbidden_content", `${question.slice(0, 50)}… → ${error.code}`);
    assert.equal(error.stage, "content");
    assert.equal(error.retryable, false);
    if (raw !== undefined) assert.ok(!JSON.stringify(raw).includes(question), "the question is echoed back");
  }

  for (const [n, name, questions] of [
    [1, "push-poll disguised as a question", PUSH_POLLS],
    [2, "request for third-party personal data", THIRD_PARTY],
    [3, "labour disguised as a question", LABOUR],
  ] as const) {
    test(`case ${n}: ${name} → forbidden_content, at the first leg and through the approval form`, async () => {
      const since = serverNow();
      for (const q of questions) {
        // Sent as the question: refused before any approval is shown.
        forbidden(await refusedAtFirstLeg(mv({ question: q })), q);
        // Sent to a participant whose rules would otherwise let it through.
        forbidden(await refusedAtFirstLeg(manifest(TH, "knowledge", 6000, q)), q);
      }
      // Smuggled in through the approval form: a benign question approved,
      // then edited into each forbidden one on accept.
      for (const q of questions) {
        const round = await approvalRound(c, mv());
        const result = await retryLeg(c, mv(), round.requestState, accept(q));
        forbidden(errorOf(result), q, result);
      }
      // Swapped into the arguments of the retry under a benign approval: the state no longer matches.
      const round = await approvalRound(c, mv());
      const swapped = await retryLeg(c, mv({ question: questions[0] }), round.requestState, accept(BENIGN));
      assert.ok(["conflict", "forbidden_content"].includes(errorOf(swapped).code), `swap on retry → ${errorOf(swapped).code}`);
      await assertNothingCreatedFor(c, MV, since);
      await assertNothingCreatedFor(c, TH, since);
    });
  }

  for (const [label, question] of EVASIONS) {
    test(`known limit of the deterministic rules (D6, OPEN): ${label}`, { todo: "reported to the PM; a classifier is an M3 proposal" }, async () => {
      const since = serverNow();
      const raw = await firstLeg(c, mv({ question }));
      if (isInputRequired(raw)) await retryLeg(c, mv({ question }), raw.requestState, { action: "cancel" });
      await assertNothingCreatedFor(c, MV, since);
      assert.ok(!isInputRequired(raw), "the approval was shown: this evasion gets past the content rules");
      assert.equal(errorOf(raw).code, "forbidden_content");
    });
  }

  test("case 4: delivery inside quiet hours → deferred, or refused when the expiry does not allow it", async (t) => {
    // sim-ep-5c07: quiet 22:00-07:00 Europe/London, latency 24 h. The
    // server's clock decides; by day this case cannot be provoked from
    // outside and is reported as such (local stage with a pinned clock:
    // tests/README.md, "Adversarial suite").
    const EP = "sim-ep-5c07";
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(serverNow()));
    if (!(hour >= 22 || hour < 7)) {
      t.skip(`London hour ${hour}: outside sim-ep-5c07's quiet hours, the case cannot be provoked now`);
      return;
    }
    const since = serverNow();
    const q = "Is the vocabulary of this picture book right for five-year-olds?";
    const roomy = manifest(EP, "judgment", 2600, q, { expires_at: expiresIn(3 * 86_400) });
    const round = await approvalRound(c, roomy);
    const message = round.inputRequests!["approval"]!.params.message;
    assert.match(message, /deferred to/i, "inside quiet hours the delivery is deferred, never now");
    assert.doesNotMatch(message, /Delivery: now/);
    await retryLeg(c, roomy, round.requestState, { action: "cancel" });
    // An expiry shorter than the latency promise from now cannot fit a deferred delivery: refused, retryable.
    for (const seconds of [12 * 3600, 23 * 3600]) {
      const error = await refusedAtFirstLeg(manifest(EP, "judgment", 2600, q, { expires_at: expiresIn(seconds) }));
      assert.equal(error.code, "outside_participant_rules");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(JSON.stringify(error), /22:00|07:00|quiet/i, "the refusal reveals the participant's quiet hours");
    }
    await assertNothingCreatedFor(c, EP, since);
  });

  test("case 5: over-interruption → blocked, also for approvals minted before the budget ran out", async () => {
    // sim-bk-2e6f: two interruptions a UTC day. Mint three approvals first,
    // while the rules may still allow them, then redeem them: at most the
    // remaining budget is created, every other accept is refused on the
    // retry's re-validation, and later first legs are refused outright.
    const BK = "sim-bk-2e6f";
    const args = manifest(BK, "estimate", 4400, "How many days does road freight from Lyon to Rotterdam take this month?");
    const rounds: InputRequiredRound[] = [];
    const firstRefusals: ToolError[] = [];
    for (let i = 0; i < 3; i++) {
      const raw = await firstLeg(c, args);
      if (isInputRequired(raw)) rounds.push(raw);
      else firstRefusals.push(errorOf(raw));
    }
    let created = 0;
    const retryRefusals: ToolError[] = [];
    for (const round of rounds) {
      const result = await retryLeg(c, args, round.requestState, accept(String(args["question"])));
      if (result.isError) retryRefusals.push(errorOf(result));
      else {
        assert.equal(RequestHumanOutputSchema.parse(result.structuredContent).status, "sent");
        created++;
      }
    }
    assert.ok(created <= 2, `${created} requests were created past a budget of two a day`);
    const after = await refusedAtFirstLeg(args);
    for (const e of [...firstRefusals, ...retryRefusals, after]) {
      assert.equal(e.code, "outside_participant_rules");
      assert.equal(e.stage, "rules");
      assert.doesNotMatch(e.detail ?? "", /interruption|per day|\b2\b/i, "the refusal reveals the participant's daily limit");
    }
    assert.ok(firstRefusals.length + retryRefusals.length >= 1, "the third mint or redeem of the day is refused");
  });

  test("case 6: bid below reserve → outside_participant_rules, no approval, no request, no hold", async () => {
    const since = serverNow();
    const cases: [string, Args, string | string[]][] = [
      ["one cent below the gross reserve", mv({ bid_minor: 3124 }), "outside_participant_rules"],
      ["the net reserve (fee left out)", mv({ bid_minor: 2500 }), "outside_participant_rules"],
      ["zero on the paid lane", mv({ bid_minor: 0 }), ["schema_invalid", "outside_participant_rules"]],
      ["a free lane the participant never declared", manifest(TH, "knowledge", 0, "What does a conveyancer check first in a leasehold purchase?", { lane: "free", free_lane: "own_publications" }), "outside_participant_rules"],
      ["a negative bid", mv({ bid_minor: -3200 }), "schema_invalid"],
      ["a fractional bid", mv({ bid_minor: 3124.5 }), "schema_invalid"],
      ["a bid as a string", mv({ bid_minor: "3200" }), "schema_invalid"],
    ];
    for (const [label, args, code] of cases) {
      const error = await refusedAtFirstLeg(args);
      assert.ok([code].flat().includes(error.code), `${label} → ${error.code}, expected ${String(code)}`);
      const text = JSON.stringify(error).toLowerCase();
      for (const leak of ["3125", "31.25", "2500", "25.00", "5625", "reserve is"]) assert.ok(!text.includes(leak), `${label}: the refusal states the reserve (${leak})`);
    }
    // Approved at a valid bid, retried with a lower one: the approval does not cover it.
    const round = await approvalRound(c, mv());
    const lowered = await retryLeg(c, mv({ bid_minor: 3124 }), round.requestState, accept(BENIGN));
    assert.ok(["conflict", "outside_participant_rules"].includes(errorOf(lowered).code));
    await assertNothingCreatedFor(c, MV, since);
    await assertNothingCreatedFor(c, TH, since);
  });
});
