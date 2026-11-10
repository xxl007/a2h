// Contract tests against a live stage for protocol/request-approval and
// protocol/schemas as modified by openspec/changes/archive/2026-11-07-m2-approval-page (the
// archived M1 scenarios that still stand: validation before anything else).
// request_human records a valid manifest as awaiting approval and returns the
// link; the principal decides on the hosted approval page, driven here with
// Playwright as the QA principals (tests/lib/approval-page.ts). The scenarios
// that need a sent request (Send on the page, Accept after editing, Decision
// replayed) are in request-flows.test.ts, which reuses its sent requests;
// the link's expiry (Link expires unused) in approval-expiry.test.ts, which
// takes over fifteen minutes and runs alongside the other suites.
//
// Handles: sim-mv-7f3c for everything here (awaiting rows it leaves expire
// within a day; no other file run at the same time checks that nothing was
// created for it), sim-ep-5c07 (Quiet hours), sim-bk-2e6f (Interruption
// budget exceeded), sim-rc-8d14 (Blocked row). Nothing in this file is sent
// except the at most two daily requests to sim-bk-2e6f.
// Run: A2H_MCP_URL=… A2H_TOKEN=… A2H_SESSION_STATE=… A2H_SESSION_STATE_2=… pnpm --filter @a2h/tests contract
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "@playwright/test";
import { REQUEST_ID_PATTERN, RequestHumanOutputSchema } from "@a2h/protocol";
import {
  assertNothingCreatedFor,
  checkOne,
  errorOf,
  expiresIn,
  firstLeg,
  isInputRequired,
  legacyClient,
  manifest,
  principalClient,
  requestAwaiting,
  retryLeg,
  serverNow,
  texts,
  type A2hClient,
  type Answer,
} from "./a2h.ts";
import { recordingFetch, PROTOCOL_VERSION } from "./mcp-client.ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { bearerToken, expectedStage, gateExpectation, mcpUrl, secondToken, webUrl } from "../src/live-env.ts";
import {
  closePage,
  decide,
  dontSendButton,
  launch,
  mainText,
  openLink,
  PAGE,
  pageAs,
  pageSkip,
  questionBox,
  requestIdOf,
  sendButton,
} from "../lib/approval-page.ts";

const MV = "sim-mv-7f3c"; // judgment, net 2500 → gross 3125, prompt persona, latency 6 h
const QUESTION = "Would a patient with type 2 diabetes find the insulin section of this leaflet alarming?";
const PUSH_POLL = "Would you still trust this clinic if you learned its director lied about the results?";
const THIRD_PARTY = "What is your colleague's home address?";
const LABOUR = "Please write a 2,000-word report on insulin pricing.";

// The seed's one organisation-only persona (packages/db seed.test.ts "who may
// ask"): knowledge, net 2500 → gross 3125. With the gate on the caller is the
// signed-in principal, a person (consent creates identity_mode real_name).
const RC = "sim-rc-8d14";
const STAGE = expectedStage(mcpUrl());
const GATE = await gateExpectation(STAGE);
const WEB = await webUrl(STAGE);
const PAGE_A = pageSkip("a");
const PAGE_AB = pageSkip("a", "b") || (secondToken() ? false : "needs A2H_TOKEN_2");

const base = (extra: Record<string, unknown> = {}) => manifest(MV, "judgment", 3200, QUESTION, extra);

/** A2H's link: https, the stage's web host, /approve/<id>, a token in `t`, nothing else. */
function assertLink(link: string, id: string): void {
  const u = new URL(link);
  assert.equal(u.protocol, "https:", "the link is https");
  assert.equal(u.origin, new URL(WEB).origin, "the link is on the stage's web host");
  assert.equal(u.pathname, `/approve/${id}`);
  assert.deepEqual([...u.searchParams.keys()], ["t"], "the token is the only query parameter");
  assert.match(u.searchParams.get("t") ?? "", /^[A-Za-z0-9_-]{43}$/, "an unguessable token (32 bytes, base64url)");
}

describe("protocol/request-approval (live)", () => {
  let c: A2hClient;
  let browser: Browser | undefined;
  before(async () => {
    c = await principalClient();
    if (!PAGE_A) browser = await launch();
  });
  after(async () => {
    await c?.close();
    await browser?.close();
  });

  // ---- Manifest validation runs before anything else -----------------------

  test("Scenario: Bid below reserve", async () => {
    const since = serverNow();
    const raw = await firstLeg(c, base({ bid_minor: 3124 }));
    assert.ok(!isInputRequired(raw), "no link is offered");
    const error = errorOf(raw);
    assert.equal(error.code, "outside_participant_rules");
    assert.equal(error.stage, "rules");
    const everything = JSON.stringify(raw).toLowerCase();
    for (const leak of ["3125", "31.25", "2500", "25.00", "reserve", "/approve/"]) assert.ok(!everything.includes(leak), `the refusal states ${leak}`);
    await assertNothingCreatedFor(c, MV, since);
  });

  // protocol/request-approval "Blocked row", observable part: refused at the
  // rules stage with no link, nothing is created, and the refusal names a
  // category, not the rule. The row itself: apps/mcp/test/request-human.test.ts.
  test("Scenario: Blocked row (observable part: a signed-in person asks an organisation-only participant; refused at the rules stage, nothing created)", { skip: GATE.authRequired ? false : `AUTH_REQUIRED=false on ${STAGE}: the caller is the fallback principal, an organisation` }, async () => {
    const since = serverNow();
    const raw = await firstLeg(c, manifest(RC, "knowledge", 3200, "How do I descale a commercial espresso machine boiler safely?"));
    assert.ok(!isInputRequired(raw), "no link is offered");
    const error = errorOf(raw);
    assert.equal(error.code, "outside_participant_rules");
    assert.equal(error.stage, "rules");
    assert.ok(!/organi[sz]ation|who_may_ask|asker/i.test(JSON.stringify(raw)), "the refusal names a category, not the participant's rule");
    await assertNothingCreatedFor(c, RC, since);
  });

  for (const [scenario, question] of [
    ["Push-poll", PUSH_POLL],
    ["Third-party personal data", THIRD_PARTY],
    ["Labour disguised as a question", LABOUR],
  ] as const) {
    test(`Scenario: ${scenario}`, async () => {
      const since = serverNow();
      const raw = await firstLeg(c, base({ question }));
      assert.ok(!isInputRequired(raw), "no link is offered");
      const error = errorOf(raw);
      assert.equal(error.code, "forbidden_content");
      assert.equal(error.stage, "content");
      assert.ok(!JSON.stringify(raw).includes(question), "the question is not echoed");
      await assertNothingCreatedFor(c, MV, since);
    });
  }

  test("Scenario: Shape outside this change", async () => {
    const since = serverNow();
    const shapes: [string, Record<string, unknown>, RegExp][] = [
      ["audience panel_sample", base({ audience: "panel_sample" }), /audience/],
      ["audience role_qualified_first_to_accept", base({ audience: "role_qualified_first_to_accept" }), /audience/],
      ["time shape threaded", base({ time_shape: "threaded" }), /time_shape/],
      ["time shape recurring", base({ time_shape: "recurring" }), /time_shape/],
    ];
    for (const [label, args, field] of shapes) {
      const raw = await firstLeg(c, args);
      assert.ok(!isInputRequired(raw), `${label}: a link was offered for a shape this change does not deliver`);
      const error = errorOf(raw);
      assert.equal(error.code, "schema_invalid", `${label} → ${error.code}`);
      assert.match(error.detail ?? "", field, `${label}: the detail does not name the field`);
      assert.match(error.detail ?? "", /\bM[1-9]\b/, `${label}: the detail does not name the milestone that introduces it`);
    }
    await assertNothingCreatedFor(c, MV, since);
  });

  // m2-attachments delta: attachments left "Shape outside this change" for their own scenario.
  test("Scenario: Attachments from the agent", async () => {
    const since = serverNow();
    const raw = await firstLeg(c, base({ attachments: [{ ref: "att-0001", media_type: "application/pdf", size_bytes: 1024 }] }));
    assert.ok(!isInputRequired(raw), "a link was offered for a manifest carrying the agent's attachments");
    const error = errorOf(raw);
    assert.equal(error.code, "schema_invalid");
    assert.match(error.detail ?? "", /attachments/, "the detail names the field");
    assert.match(error.detail ?? "", /principal/, "the detail says who adds files");
    assert.match(error.detail ?? "", /approval page/, "the detail says where files are added");
    await assertNothingCreatedFor(c, MV, since);
  });

  test("Scenario: Quiet hours (branch decided by the server's clock in Europe/London; the delivery time is shown on the approval page)", { skip: PAGE_A }, async (t) => {
    // sim-ep-5c07: quiet 22:00-07:00 Europe/London, latency 24 h, judgment net 2000 (gross 2500).
    // By day the deferral is not observable and only "delivery now" is checked; the deferred and refused
    // branches run between 22:00 and 07:00 London time, and in apps/mcp/test/request-human.test.ts.
    const EP = "sim-ep-5c07";
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(serverNow()));
    const quiet = hour >= 22 || hour < 7;
    const args = manifest(EP, "judgment", 2600, "Is the vocabulary of this picture book right for five-year-olds?", { expires_at: expiresIn(3 * 86_400) });
    const { out } = await requestAwaiting(c, args);
    const page = await pageAs(browser!, "a");
    try {
      assert.equal(await openLink(page, out.approval_url), PAGE.awaiting);
      // packages/ui copy.approval deliveryNow: "As soon as you send." (otherwise the deferred time).
      const delivery = await mainText(page);
      if (!quiet) {
        assert.match(delivery, /As soon as you send/, "outside quiet hours the delivery is now");
        t.diagnostic(`London hour ${hour}: outside quiet hours, deferral not observable now`);
      } else {
        assert.doesNotMatch(delivery, /As soon as you send/, "inside quiet hours the page says the delivery is deferred");
        const tooSoon = await firstLeg(c, { ...args, expires_at: expiresIn(23 * 3600) });
        const error = errorOf(tooSoon);
        assert.equal(error.code, "outside_participant_rules");
        assert.equal(error.retryable, true);
      }
      assert.equal((await decide(page, "dont_send")).heading, PAGE.notSent);
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Interruption budget exceeded (sends on the page until the participant's daily limit refuses)", { skip: PAGE_A }, async () => {
    // sim-bk-2e6f accepts at most 2 interruptions a UTC day (silent persona, latency 24 h, estimate net
    // 3500 → gross 4375). Requests are sent on the page until it refuses: at the first leg once two were
    // sent today, or on Send (re-validation, D4) when two were sent between the link and the Send.
    const BK = "sim-bk-2e6f";
    const args = manifest(BK, "estimate", 4400, "How many days does road freight from Lyon to Rotterdam take this month?");
    let refused: string | undefined;
    for (let attempt = 1; attempt <= 3 && !refused; attempt++) {
      const raw = await firstLeg(c, args);
      if (isInputRequired(raw) || raw.isError) {
        const error = errorOf(raw);
        assert.equal(error.code, "outside_participant_rules");
        assert.equal(error.stage, "rules");
        assert.ok(!/interruption|per day|\b2\b/i.test(error.detail ?? ""), `the detail reveals the participant's rule: ${error.detail}`);
        refused = "first leg";
        break;
      }
      const out = RequestHumanOutputSchema.parse(raw.structuredContent);
      const page = await pageAs(browser!, "a");
      try {
        await openLink(page, out.approval_url!);
        const d = await decide(page, "send");
        if (d.heading === PAGE.sent) continue;
        assert.equal(d.heading, PAGE.awaiting, `unexpected page after Send: ${d.heading}`);
        assert.ok(d.alerts.some((a) => a.includes("It no longer fits their rules")), `the page names the category: ${JSON.stringify(d.alerts)}`);
        assert.ok(!d.alerts.some((a) => /interruption|per day|\b2\b/i.test(a)), "the page reveals the participant's rule");
        refused = "send";
        assert.equal((await checkOne(c, out.request_id)).status, "awaiting_approval", "a refused Send leaves the request awaiting approval");
        await decide(page, "dont_send");
      } finally {
        await closePage(page);
      }
    }
    assert.ok(refused, "a third request on the same UTC day is refused");
    // The block is counted for the participant (blocked_manifests, code interruption_budget):
    // not visible from outside; apps/mcp/test/request-human.test.ts, packages/db/test/approval.test.ts.
  });

  // ---- Approval happens on the hosted approval page --------------------------

  let linkReturned: Awaited<ReturnType<typeof requestAwaiting>> | undefined;

  test("Scenario: Link returned (and protocol/schemas: Awaiting approval)", async () => {
    const before = serverNow();
    linkReturned = await requestAwaiting(c, base());
    const { out, result } = linkReturned;
    assert.match(out.request_id, REQUEST_ID_PATTERN);
    assertLink(out.approval_url, out.request_id);
    const expires = Date.parse(out.approval_expires_at);
    assert.ok(expires > before.getTime() + 14 * 60_000, "the link lasts at least fifteen minutes (design D2)");
    assert.ok(expires <= serverNow().getTime() + 24 * 3600_000 + 5_000, "the link lasts at most 24 hours (design D2)");
    // The text leads with the link and tells the agent to show it (design D3, risk "the agent forgets").
    const text = texts(result);
    assert.ok(text.split("\n")[0]!.includes(out.approval_url), "the first line carries the link");
    assert.match(text, /show the principal/i);
    assert.match(text, /check_requests/);
    assert.ok(!text.includes(QUESTION), "the question is not echoed in the result");
    // No hold, no delivery: check_requests sees it awaiting, nothing held, no sent_at.
    const r = await checkOne(c, out.request_id);
    assert.equal(r.status, "awaiting_approval");
    assert.equal(r.held_minor, undefined);
    assert.equal(r.hold_status, "none");
    assert.equal(r.transitions.sent_at, undefined);
    assert.deepEqual(Object.keys(r.transitions), ["awaiting_approval_at"]);
  });

  test("Scenario: Return under a second", () => {
    assert.ok(linkReturned, "see 'Scenario: Link returned'");
    assert.ok(linkReturned.ms < 1000, `request_human took ${Math.round(linkReturned.ms)} ms`);
    assert.match(linkReturned.out.request_id, REQUEST_ID_PATTERN);
    assert.equal(linkReturned.out.status, "awaiting_approval");
    assert.ok(linkReturned.out.approval_url && linkReturned.out.approval_expires_at);
    assert.equal((linkReturned.result.structuredContent as { held_minor?: number }).held_minor, undefined, "no hold in the result");
  });

  test("Scenario: Client with URL elicitation", async () => {
    const urlClient = await principalClient({ url: true });
    try {
      const args = base();
      const raw = await firstLeg(urlClient, args);
      assert.ok(isInputRequired(raw), `a client that declares URL elicitation is asked through it: ${JSON.stringify(raw).slice(0, 200)}`);
      assert.deepEqual(Object.keys(raw.inputRequests ?? {}), ["approval"]);
      const req = raw.inputRequests!["approval"]!;
      assert.equal(req.method, "elicitation/create");
      assert.equal(req.params.mode, "url");
      const link = req.params.url!;
      const id = requestIdOf(link);
      assertLink(link, id);
      assert.equal(req.params.message.trim().split(/(?<=[.!?])\s+/).length, 1, `one sentence: ${req.params.message}`);
      assert.equal(typeof raw.requestState, "string");
      // The host opened the page (accept): the eventual result carries the same id and link.
      const result = await retryLeg(urlClient, args, raw.requestState, { action: "accept" });
      assert.ok(!result.isError, texts(result));
      const out = RequestHumanOutputSchema.parse(result.structuredContent);
      assert.equal(out.status, "awaiting_approval");
      assert.equal(out.request_id, id);
      assert.equal(out.approval_url, link);
      assert.equal((await checkOne(c, id)).status, "awaiting_approval", "accepting the prompt only opens the page; nothing is sent");
    } finally {
      await urlClient.close();
    }
  });

  for (const [how, answer] of [
    ["declines", { action: "decline" }],
    ["dismisses", { action: "cancel" }],
  ] as const satisfies readonly (readonly [string, Answer])[]) {
    test(`Scenario: Principal refuses to open the link (the host ${how} the prompt; and protocol/schemas: Request not sent)`, async () => {
      const urlClient = await principalClient({ url: true });
      try {
        const args = base();
        const raw = await firstLeg(urlClient, args);
        assert.ok(isInputRequired(raw));
        const id = requestIdOf(raw.inputRequests!["approval"]!.params.url!);
        const result = await retryLeg(urlClient, args, raw.requestState, answer);
        assert.ok(!result.isError, texts(result));
        const out = RequestHumanOutputSchema.parse(result.structuredContent);
        assert.deepEqual(out, { status: "not_sent", request_id: id, reason: "declined" }, "not_sent, the id, declined, and no approval_url");
        assert.match(texts(result), /not sent/i);
        assert.ok(texts(result).includes(id));
        const r = await checkOne(c, id);
        assert.equal(r.status, "not_sent");
        assert.equal(r.reason, "declined");
        assert.equal(r.held_minor, undefined, "nothing held");
        assert.equal(r.hold_status, "none");
        assert.equal(r.transitions.sent_at, undefined, "nothing delivered");
      } finally {
        await urlClient.close();
      }
    });
  }

  test("Scenario: Client without URL elicitation (no elicitation; forms only; a 2025-era client)", async () => {
    const check = async (label: string, raw: Awaited<ReturnType<typeof firstLeg>>) => {
      assert.ok(!isInputRequired(raw), `${label}: asked through an elicitation it did not declare`);
      assert.ok(!raw.isError, `${label}: refused: ${texts(raw)}`);
      const out = RequestHumanOutputSchema.parse(raw.structuredContent);
      assert.equal(out.status, "awaiting_approval", label);
      const text = texts(raw);
      assert.ok(text.includes(out.approval_url!), `${label}: the text carries the link`);
      assert.match(text, /show the principal this approval link/i, `${label}: the instruction to show it`);
      assert.equal((await checkOne(c, out.request_id)).status, "awaiting_approval", label);
    };
    await check("no elicitation", await firstLeg(c, base()));

    const { fetch } = recordingFetch(globalThis.fetch, bearerToken());
    const formsOnly = new Client({ name: "a2h-contract-forms-only", version: "0.0.0" }, { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } }, capabilities: { elicitation: { form: {} } }, inputRequired: { autoFulfill: false } });
    await formsOnly.connect(new StreamableHTTPClientTransport(mcpUrl(), { fetch }), { timeout: 30_000 });
    try {
      await check("forms only", await formsOnly.callTool({ name: "request_human", arguments: base() }, { allowInputRequired: true, timeout: 30_000 }));
    } finally {
      await formsOnly.close();
    }

    let elicited = false;
    const legacy = await legacyClient(() => (elicited = true));
    try {
      assert.equal(legacy.client.getProtocolEra(), "legacy");
      await check("2025-era client", await legacy.client.callTool({ name: "request_human", arguments: base() }, { timeout: 30_000 }));
      assert.equal(elicited, false, "the 2025-era client is never asked");
    } finally {
      await legacy.close();
    }
  });

  test("Scenario: Don't send on the page", { skip: PAGE_A }, async () => {
    const { out } = await requestAwaiting(c, base());
    const page = await pageAs(browser!, "a");
    try {
      assert.equal(await openLink(page, out.approval_url), PAGE.awaiting);
      const d = await decide(page, "dont_send");
      assert.equal(d.heading, PAGE.notSent);
      assert.match(await mainText(page), /was not contacted and will not learn about this request/);
    } finally {
      await closePage(page);
    }
    const r = await checkOne(c, out.request_id);
    assert.equal(r.status, "not_sent");
    assert.equal(r.reason, "declined");
    assert.equal(r.held_minor, undefined, "nothing held");
    assert.equal(r.hold_status, "none");
    assert.deepEqual(Object.keys(r.transitions).sort(), ["awaiting_approval_at", "not_sent_at"], "never sent, never delivered");
  });

  // ---- The link is single-use and bound to its principal ---------------------

  test("Scenario: Another principal opens the link", { skip: PAGE_AB }, async () => {
    const { out } = await requestAwaiting(c, base());
    const theirs = await pageAs(browser!, "b");
    try {
      assert.equal(await openLink(theirs, out.approval_url), PAGE.wrongPrincipal);
      const shown = await mainText(theirs);
      for (const leak of [out.request_id, QUESTION, "Margaret", MV, "€", "32.00"]) assert.ok(!shown.includes(leak), `the other account's page shows ${leak}`);
      assert.equal(await sendButton(theirs).count(), 0, "no Send");
      assert.equal(await dontSendButton(theirs).count(), 0, "no Don't send");
      assert.equal(await questionBox(theirs).count(), 0, "no question");
    } finally {
      await closePage(theirs);
    }
    const r = await checkOne(c, out.request_id);
    assert.equal(r.status, "awaiting_approval", "the request is unchanged");
    assert.equal(r.approval_expires_at, out.approval_expires_at);
    const mine = await pageAs(browser!, "a");
    try {
      assert.equal(await openLink(mine, out.approval_url), PAGE.awaiting, "the principal still sees it");
      assert.equal(await questionBox(mine).inputValue(), QUESTION);
    } finally {
      await closePage(mine);
    }
  });

  test("Scenario: Forged token (a token the server never issued, and another request's genuine token: the expired page, nothing revealed)", { skip: PAGE_A }, async () => {
    const { out } = await requestAwaiting(c, base());
    const { out: other } = await requestAwaiting(c, base());
    const id = out.request_id;
    const forged = new URL(out.approval_url);
    forged.searchParams.set("t", `${"A".repeat(42)}A`);
    const swapped = new URL(out.approval_url);
    swapped.searchParams.set("t", new URL(other.approval_url).searchParams.get("t")!);
    const unknown = new URL(forged);
    unknown.pathname = "/approve/A2H-0000";
    const page = await pageAs(browser!, "a");
    try {
      const seen: string[] = [];
      for (const link of [forged.href, swapped.href, unknown.href]) {
        assert.equal(await openLink(page, link), PAGE.expired, `${new URL(link).pathname}: the expired page`);
        const text = await mainText(page);
        assert.ok(!text.includes(id) && !text.includes(QUESTION) && !text.includes("Margaret"), "the page reveals the request");
        assert.equal(await sendButton(page).count(), 0, "no Send on a forged link");
        seen.push(text);
      }
      assert.equal(seen[0], seen[2], "a forged token on a real request reads exactly as one on a request that does not exist");
      assert.equal(seen[1], seen[2], "another request's token reads the same");
    } finally {
      await closePage(page);
    }
    assert.equal((await checkOne(c, id)).status, "awaiting_approval", "the request is unchanged");
  });

  // ---- Approval covers the validated manifest ----------------------------------

  test("Scenario: Edit turns the question into a push-poll", { skip: PAGE_A }, async () => {
    const { out } = await requestAwaiting(c, base());
    const page = await pageAs(browser!, "a");
    try {
      await openLink(page, out.approval_url);
      const d = await decide(page, "send", { question: PUSH_POLL });
      assert.equal(d.heading, PAGE.awaiting, "Send fails and the page stays on the request");
      assert.ok(d.alerts.some((a) => a.includes("This wording can't be sent") && a.includes("Nothing was sent and nothing is held.")), `the page says so: ${JSON.stringify(d.alerts.map((a) => a.slice(0, 80)))}`);
      assert.equal(await questionBox(page).inputValue(), PUSH_POLL, "the edited text is kept");
      let r = await checkOne(c, out.request_id);
      assert.equal(r.status, "awaiting_approval", "stays awaiting_approval");
      assert.equal(r.held_minor, undefined, "nothing held");
      // ... until a valid Send, Don't send or expiry: Don't send still works.
      assert.equal((await decide(page, "dont_send")).heading, PAGE.notSent);
      r = await checkOne(c, out.request_id);
      assert.equal(r.status, "not_sent");
      assert.equal(r.transitions.sent_at, undefined, "never delivered");
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Budget spent meanwhile", { skip: "spending a principal's monthly budget on a shared preview would block the owner's Gate 2 run; packages/db/test/approval.test.ts \"Scenario: Budget spent meanwhile\" (decideApproval) and apps/web/test/approval-page.test.ts (the page's wording)" }, () => {});

  test("Scenario: Link expires unused", { skip: "takes over fifteen minutes (the shortest link, design D2): tests/contract/approval-expiry.test.ts, started in the background by the verify job (A2H_LONG_FLOWS=1)" }, () => {});

  // ---- protocol/schemas ----------------------------------------------------------

  test("Scenario: Free lane with a bid (protocol/schemas): refused on bid_minor, nothing created", async () => {
    // sim-th-2a91: no request is recorded for it in this file (the awaiting requests above are sim-mv-7f3c's,
    // and listSince looks back to the whole second before `since`). The schema refuses before any rule.
    const TH = "sim-th-2a91";
    const since = serverNow();
    const raw = await firstLeg(c, manifest(TH, "knowledge", 100, "What does a conveyancer check first in a leasehold purchase?", { lane: "free", free_lane: "own_publications" }));
    assert.ok(!isInputRequired(raw));
    const error = errorOf(raw);
    assert.equal(error.code, "schema_invalid");
    assert.match(error.detail ?? "", /bid_minor/);
    await assertNothingCreatedFor(c, TH, since);
  });
});
