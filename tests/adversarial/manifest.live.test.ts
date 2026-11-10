// Adversarial suite, manifest side, against a live stage (A2H_MCP_URL):
// cases 1 to 6 of the protocol skill §12. Every case must fail closed:
// refused with the right category, nothing created where the first leg is
// refused, nothing sent where the approval page refuses, and no participant
// rule revealed. Each case attacks more than the plain scenario of the
// contract suite: paraphrases, the edit on the approval page (m2-approval-
// page: Send re-validates, design D4), links minted while the rules allowed
// a request and sent after, and argument swaps on the URL prompt's retry.
//
// Known limits of the deterministic content rules (design D6; the detection
// method is OPEN until M3) are recorded as `todo` tests: they report, without
// failing the run, the evasions that get through today.
//
// Handles: sim-mv-7f3c and sim-th-2a91 get no request from this file (their
// nothing-created checks); sim-ns-0d39 and sim-ep-5c07 get awaiting requests
// that are never sent; sim-bk-2e6f gets at most its two a day (shared with
// the contract suite's "Interruption budget exceeded"); sim-dm-7b80 only the
// known-limit todos. The page cases need the QA principal's session.
// Run: A2H_MCP_URL=… A2H_TOKEN=… A2H_SESSION_STATE=… pnpm --filter @a2h/tests adversarial
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { RequestHumanOutputSchema } from "@a2h/protocol";
import {
  assertNothingCreatedFor,
  checkOne,
  errorOf,
  expiresIn,
  firstLeg,
  isInputRequired,
  iso,
  manifest,
  principalClient,
  requestAwaiting,
  retryLeg,
  serverNow,
  type A2hClient,
  type Args,
  type ToolError,
} from "../contract/a2h.ts";
import { closePage, decide, launch, mainText, openLink, PAGE, pageAs, pageSkip, questionBox, sendButton } from "../lib/approval-page.ts";

const PAGE_A = pageSkip("a");
// Can't-tell persona, knowledge net 1500 → gross 1875: the page cases' awaiting requests (never sent).
const NS = "sim-ns-0d39";
const ns = (extra: Args = {}) => manifest(NS, "knowledge", 1900, "Which pear varieties are least prone to scab in a wet climate?", extra);

const MV = "sim-mv-7f3c"; // judgment net 2500 → gross 3125; own_publications free lane
const TH = "sim-th-2a91"; // knowledge net 4500 → gross 5625, verification net 3500 → 4375; no free lane
// Decline persona, judgment net 1800 → gross 2250: only the known-limit todos send to it (m2-approval-page 3.1).
const DM = "sim-dm-7b80";
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
    test(`case ${n}: ${name} → forbidden_content at the first leg`, async () => {
      const since = serverNow();
      for (const q of questions) {
        // Sent as the question: refused before anything is recorded.
        forbidden(await refusedAtFirstLeg(mv({ question: q })), q);
        // Sent to a participant whose rules would otherwise let it through.
        forbidden(await refusedAtFirstLeg(manifest(TH, "knowledge", 6000, q)), q);
      }
      await assertNothingCreatedFor(c, MV, since);
      await assertNothingCreatedFor(c, TH, since);
    });

    test(`case ${n}: ${name} → refused on the approval page when a benign question is edited into it; the request stays awaiting, nothing sent`, { skip: PAGE_A }, async () => {
      const browser = await launch();
      try {
        // Smuggled in through the page's editor: a benign request recorded, then edited into each forbidden question on Send.
        for (const q of questions) {
          const { out } = await requestAwaiting(c, ns());
          const page = await pageAs(browser, "a");
          try {
            await openLink(page, out.approval_url);
            const d = await decide(page, "send", { question: q });
            assert.equal(d.heading, PAGE.awaiting, `${q.slice(0, 50)}…: Send went through (${d.heading})`);
            assert.ok(d.alerts.some((a) => a.includes("This wording can't be sent")), `${q.slice(0, 50)}…: ${JSON.stringify(d.alerts.map((a) => a.slice(0, 60)))}`);
            const r = await checkOne(c, out.request_id);
            assert.equal(r.status, "awaiting_approval", "a refused Send leaves the request awaiting approval");
            assert.equal(r.held_minor, undefined, "nothing held");
            assert.equal((await decide(page, "dont_send")).heading, PAGE.notSent);
          } finally {
            await closePage(page);
          }
        }
        // Swapped into the arguments of the URL prompt's retry: the request is the one the state names,
        // with the question it was recorded with; the swapped text is recorded nowhere.
        const url = await principalClient({ url: true });
        try {
          const args = ns();
          const round = await firstLeg(url, args);
          assert.ok(isInputRequired(round));
          const link = round.inputRequests!["approval"]!.params.url!;
          const swapped = await retryLeg(url, { ...args, question: questions[0] }, round.requestState, { action: "accept" });
          assert.ok(!swapped.isError, JSON.stringify(swapped).slice(0, 200));
          assert.equal(RequestHumanOutputSchema.parse(swapped.structuredContent).approval_url, link, "the retry names the recorded request");
          const page = await pageAs(browser, "a");
          try {
            assert.equal(await openLink(page, link), PAGE.awaiting);
            assert.equal(await questionBox(page).inputValue(), String(args["question"]), "the swapped question reached the request");
            await decide(page, "dont_send");
          } finally {
            await closePage(page);
          }
        } finally {
          await url.close();
        }
      } finally {
        await browser.close();
      }
    });
  }


  for (const [label, question] of EVASIONS) {
    // Since m2-approval-page 3.1 an evasion that passes the content rules is
    // recorded as awaiting approval. The todos send to DM, a persona no
    // "nothing created" check of this suite uses, so a passing evasion cannot
    // fail another case (verify pr-81, case 6). Still todo: expected to fail.
    test(`known limit of the deterministic rules (D6, OPEN): ${label}`, { todo: "reported to the PM; a classifier is an M3 proposal" }, async () => {
      const raw = await firstLeg(c, manifest(DM, "judgment", 3200, question));
      assert.ok(!isInputRequired(raw), "a URL elicitation was not expected from a forms-only client");
      assert.equal(raw.isError, true, `this evasion gets past the content rules: recorded as ${JSON.stringify(raw.structuredContent).replace(/([?&]t=)[^"&]+/g, "$1<token>")}`);
      assert.equal(errorOf(raw).code, "forbidden_content");
    });
  }


  test("case 4: delivery inside quiet hours → the page says the delivery is deferred, or the first leg refuses when the expiry does not allow it", { skip: PAGE_A }, async (t) => {
    // sim-ep-5c07: quiet 22:00-07:00 Europe/London, latency 24 h. The server's clock decides; by day
    // this case cannot be provoked from outside and is reported as such (local stage with a pinned
    // clock for the first-leg part: tests/README.md, "Adversarial suite").
    // The server reads its clock a moment after this one, so the last two minutes before 07:00 are
    // skipped too: a request made at 06:59 here can land at 07:00 there, and be delivered at once.
    const EP = "sim-ep-5c07";
    const london = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(serverNow());
    const [hour, minute] = london.split(":").map(Number) as [number, number];
    const londonMinutes = hour * 60 + minute;
    if (!(londonMinutes >= 22 * 60 || londonMinutes < 7 * 60 - 2)) {
      t.skip(`London ${london}: outside sim-ep-5c07's quiet hours (or in the two minutes before they end), the case cannot be provoked now`);
      return;
    }
    const q = "Is the vocabulary of this picture book right for five-year-olds?";
    // Expiry at noon UTC three days on, not "now + 3 days": the Expires row then never reads the
    // minute the suite runs at, so a "22:00" on the page can only be the rule's window start.
    const noon = new Date(serverNow());
    noon.setUTCDate(noon.getUTCDate() + 3);
    noon.setUTCHours(12, 0, 0, 0);
    const { out } = await requestAwaiting(c, manifest(EP, "judgment", 2600, q, { expires_at: iso(noon) }));
    const browser = await launch();
    try {
      // The page shows times in the viewer's zone (LocalTime); pinned to UTC so the delivery reads
      // 07:00 or 06:00 (London's end of quiet hours in UTC) and the expiry 12:00, wherever this runs.
      const page = await pageAs(browser, "a", { timezoneId: "UTC" });
      try {
        await openLink(page, out.approval_url);
        const text = await mainText(page);
        // The deferral itself is required (spec request-approval "Quiet hours": the result says so;
        // design.md lists deliverAt): the Delivery row names the earliest time the rules allow
        // (packages/ui copy.approval.deliveryDeferred), never "now".
        assert.doesNotMatch(text, /As soon as you send/, "inside quiet hours the delivery is deferred, never now");
        assert.match(text, /Delivery\s+At \d\d:\d\d on \d{1,2} [A-Z][a-z]{2} \d{4} \(UTC\), the earliest their rules allow\./, "the page does not show the deferred delivery time");
        // The rule stays hidden: the word, the time zone, the window's start. (Its end is the delivery
        // time, so 07:00 is not a leak; 22:00 never is a delivery time with this persona.)
        assert.doesNotMatch(text, /quiet|Europe\/London|22:00/i, "the page reveals the participant's quiet hours");
        await decide(page, "dont_send");
      } finally {
        await closePage(page);
      }
    } finally {
      await browser.close();
    }
    // An expiry shorter than the latency promise from now cannot fit a deferred delivery: refused, retryable.
    for (const seconds of [12 * 3600, 23 * 3600]) {
      const error = await refusedAtFirstLeg(manifest(EP, "judgment", 2600, q, { expires_at: expiresIn(seconds) }));
      assert.equal(error.code, "outside_participant_rules");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(JSON.stringify(error), /22:00|07:00|quiet/i, "the refusal reveals the participant's quiet hours");
    }
  });

  test("case 5: over-interruption → blocked, also for links minted before the budget ran out and sent after", { skip: PAGE_A }, async () => {
    // sim-bk-2e6f: two interruptions a UTC day. Mint three links first, while the rules may still allow
    // them, then Send them on the page: at most the remaining budget is sent, every other Send is refused
    // by the re-validation (D4), and later first legs are refused outright.
    const BK = "sim-bk-2e6f";
    const args = manifest(BK, "estimate", 4400, "How many days does road freight from Lyon to Rotterdam take this month?");
    const links: string[] = [];
    const firstRefusals: ToolError[] = [];
    for (let i = 0; i < 3; i++) {
      const raw = await firstLeg(c, args);
      if (isInputRequired(raw) || raw.isError) firstRefusals.push(errorOf(raw));
      else links.push(RequestHumanOutputSchema.parse(raw.structuredContent).approval_url!);
    }
    let sent = 0;
    let pageRefusals = 0;
    const browser = await launch();
    try {
      for (const link of links) {
        const page = await pageAs(browser, "a");
        try {
          await openLink(page, link);
          const d = await decide(page, "send");
          if (d.heading === PAGE.sent) sent++;
          else {
            assert.equal(d.heading, PAGE.awaiting);
            assert.ok(d.alerts.some((a) => a.includes("It no longer fits their rules")), JSON.stringify(d.alerts.map((a) => a.slice(0, 60))));
            assert.ok(!d.alerts.some((a) => /interruption|per day|\b2\b/i.test(a)), "the page reveals the participant's daily limit");
            pageRefusals++;
            await decide(page, "dont_send");
          }
        } finally {
          await closePage(page);
        }
      }
    } finally {
      await browser.close();
    }
    assert.ok(sent <= 2, `${sent} requests were sent past a budget of two a day`);
    const after = await refusedAtFirstLeg(args);
    for (const e of [...firstRefusals, after]) {
      assert.equal(e.code, "outside_participant_rules");
      assert.equal(e.stage, "rules");
      assert.doesNotMatch(e.detail ?? "", /interruption|per day|\b2\b/i, "the refusal reveals the participant's daily limit");
    }
    assert.ok(firstRefusals.length + pageRefusals >= 1, "the third mint or send of the day is refused");
  });


  test("case 6: bid below reserve → outside_participant_rules at the first leg, no request, no hold", async () => {
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
    await assertNothingCreatedFor(c, MV, since);
    await assertNothingCreatedFor(c, TH, since);
  });

  test("case 6: bid below reserve after the link → the page offers no way to change the bid, and a lowered bid on the prompt's retry changes nothing", { skip: PAGE_A }, async () => {
    // Recorded at a valid bid; the page's only field is the question, and Send holds exactly the validated bid.
    const url = await principalClient({ url: true });
    const browser = await launch();
    try {
      const args = ns();
      const round = await firstLeg(url, args);
      assert.ok(isInputRequired(round));
      const link = round.inputRequests!["approval"]!.params.url!;
      // The retry with a lowered bid (and a swapped participant): it names the recorded request, nothing else.
      const lowered = await retryLeg(url, { ...args, bid_minor: 1874, to: "sim-mv-7f3c" }, round.requestState, { action: "accept" });
      assert.ok(!lowered.isError);
      assert.equal(RequestHumanOutputSchema.parse(lowered.structuredContent).approval_url, link);
      const page = await pageAs(browser, "a");
      try {
        assert.equal(await openLink(page, link), PAGE.awaiting);
        assert.equal(await page.getByRole("main").getByRole("textbox").count(), 1, "the question is the only field");
        assert.equal(await page.getByRole("main").getByRole("spinbutton").count(), 0, "no amount field");
        assert.equal((await sendButton(page).innerText()).trim(), "Send · hold €19.00", "Send holds the validated bid");
        await decide(page, "dont_send");
      } finally {
        await closePage(page);
      }
    } finally {
      await url.close();
      await browser.close();
    }
  });
});
