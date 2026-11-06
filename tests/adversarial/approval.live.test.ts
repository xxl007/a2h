// Adversarial suite, approval side, against a live stage (m2-approval-page
// task 6.2): the attacks of approval.local.test.ts through the real hosted
// approval page (Playwright, as the QA principals A and B) and the real MCP
// endpoint. Fail closed expected: nothing reaches a participant that its
// principal did not choose to send on the page, in time, once.
//
//   case 1  approving another principal's request
//   case 2  replaying a decision
//   case 3  forging and guessing tokens
//   case 5  an agent moving a request out of awaiting_approval through MCP
// Case 4 (sending after the link has expired) takes over fifteen minutes:
// approval-expiry.live.test.ts, started in the background by the verify job.
//
// Each case went red first, in-process against a deliberately weakened check
// (approval.local.test.ts; the weakening and the red output are in the PR).
// Handles: sim-ol-6a23 for awaiting requests (never sent from here),
// sim-cf-4c5e for the one paid Send (case 2, gross €9.00). No other file run
// at the same time checks that nothing was created for them.
// Run: A2H_MCP_URL=… A2H_TOKEN=… A2H_TOKEN_2=… A2H_SESSION_STATE=… A2H_SESSION_STATE_2=… pnpm --filter @a2h/tests adversarial
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ProtocolError } from "@modelcontextprotocol/client";
import type { Browser } from "@playwright/test";
import { bearerToken, secondToken } from "../src/live-env.ts";
import {
  budgetGuard,
  checkOne,
  errorOf,
  firstLeg,
  isInputRequired,
  manifest,
  principalClient,
  requestAwaiting,
  retryLeg,
  type A2hClient,
  type Answer,
  type Args,
} from "../contract/a2h.ts";
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

const OL = "sim-ol-6a23"; // prompt persona, judgment net 3000 → gross 3750
const CF = "sim-cf-4c5e"; // slow persona, opinion net 700 → gross 875
const QUESTION = "Is this summary of the hospital's visiting rules clear to a first-time visitor?";
const ol = (extra: Args = {}) => manifest(OL, "judgment", 3800, QUESTION, extra);

const TOKEN = bearerToken();
const TOKEN_2 = secondToken();
const SKIP = pageSkip("a", "b") || (TOKEN && TOKEN_2 ? false : "needs A2H_TOKEN and A2H_TOKEN_2");

describe("adversarial: the approval of a request fails closed (live, through the page)", { skip: SKIP }, () => {
  let a: A2hClient;
  let b: A2hClient;
  let browser: Browser;
  before(async () => {
    a = await principalClient({ token: TOKEN! });
    b = await principalClient({ token: TOKEN_2! });
    browser = await launch();
  });
  after(async () => {
    await a?.close();
    await b?.close();
    await browser?.close();
  });

  async function unchanged(id: string, before: Awaited<ReturnType<typeof checkOne>>, what: string): Promise<void> {
    assert.deepEqual(await checkOne(a, id), before, `${what} changed the request`);
  }

  test("case 1: approving another principal's request → B sees 'another account' and nothing else; a Send of B's own page aimed at A's request does not move it; A still decides", async () => {
    const { out } = await requestAwaiting(a, ol());
    const before = await checkOne(a, out.request_id);
    const theirs = await pageAs(browser, "b");
    try {
      // B holds A's link (a leaked screen, a forwarded message): the page refuses B.
      assert.equal(await openLink(theirs, out.approval_url), PAGE.wrongPrincipal);
      const shown = await mainText(theirs);
      for (const leak of [out.request_id, QUESTION, OL, "Oliver", "€"]) assert.ok(!shown.includes(leak), `B's page shows ${leak}`);
      assert.equal(await sendButton(theirs).count() + (await dontSendButton(theirs).count()) + (await questionBox(theirs).count()), 0, "B is offered an action");

      // B's own request, opened in the same browser (which now also holds A's token cookie for A's page),
      // and its Send redirected at A's page: the server decides with B's session, never as A.
      const own = await requestAwaiting(b, manifest(CF, "opinion", 900, "Which of these two parks feels better for a Sunday picnic?", { format: "poll", options: [{ id: "a", label: "The river park" }, { id: "b", label: "The hill park" }] }));
      assert.equal(await openLink(theirs, own.out.approval_url), PAGE.awaiting);
      const target = new URL(out.approval_url);
      await theirs.route(`**/approve/${own.out.request_id}`, (route) =>
        route.request().method() === "POST" ? route.continue({ url: `${target.origin}${target.pathname}` }) : route.continue(),
      );
      await sendButton(theirs).click();
      await theirs.waitForLoadState("load").catch(() => undefined);
      await theirs.waitForTimeout(3_000);
      await theirs.unroute(`**/approve/${own.out.request_id}`);
      await unchanged(out.request_id, before, "B's redirected Send");
      // B through MCP: A's request does not exist for B.
      const read = await b.client.callTool({ name: "check_requests", arguments: { request_id: out.request_id } }, { timeout: 30_000 });
      assert.equal(errorOf(read).code, "not_found");
      // Tidy B's own request (whatever the redirected Send did to it, it was B's to decide).
      const ownNow = await checkOne(b, own.out.request_id);
      if (ownNow.status === "awaiting_approval") {
        assert.equal(await openLink(theirs, own.out.approval_url), PAGE.awaiting);
        await decide(theirs, "dont_send");
      }
    } finally {
      await closePage(theirs);
    }
    // A still sees it and can decide.
    const mine = await pageAs(browser, "a");
    try {
      assert.equal(await openLink(mine, out.approval_url), PAGE.awaiting);
      assert.equal((await decide(mine, "dont_send")).heading, PAGE.notSent);
    } finally {
      await closePage(mine);
    }
  });

  test("case 2: replaying a decision → two tabs pressing Send together send once; Send after Don't send and Don't send after Send change nothing", async (t) => {
    const guard = await budgetGuard(a, 900, 1);
    // Don't send, then the other tab's Send and the same Don't send again: already decided, nothing moves.
    const declined = await requestAwaiting(a, ol());
    const p1 = await pageAs(browser, "a");
    try {
      const p2 = await p1.context().newPage();
      for (const p of [p1, p2]) assert.equal(await openLink(p, declined.out.approval_url), PAGE.awaiting);
      assert.equal((await decide(p1, "dont_send")).heading, PAGE.notSent);
      const after = await checkOne(a, declined.out.request_id);
      assert.equal((await decide(p2, "send")).heading, PAGE.alreadyNotSent, "Send after Don't send");
      await unchanged(declined.out.request_id, after, "Send after Don't send");
      assert.equal(after.transitions.sent_at, undefined);
    } finally {
      await closePage(p1);
    }
    if (guard) {
      t.diagnostic(`concurrent Sends not run: ${guard}`);
      return;
    }
    // Two tabs press Send at the same moment: one is sent, the other sees it already sent; one hold.
    const raced = await requestAwaiting(a, manifest(CF, "opinion", 900, "Which of these two cafés feels better for a quiet morning meeting?", { format: "poll", options: [{ id: "a", label: "The corner café" }, { id: "b", label: "The bookshop café" }] }));
    const q1 = await pageAs(browser, "a");
    try {
      const q2 = await q1.context().newPage();
      for (const p of [q1, q2]) assert.equal(await openLink(p, raced.out.approval_url), PAGE.awaiting);
      const outcomes = (await Promise.all([decide(q1, "send"), decide(q2, "send")])).map((d) => d.heading).sort();
      assert.deepEqual(outcomes, [PAGE.sent, PAGE.alreadySent].sort(), `two concurrent Sends: ${JSON.stringify(outcomes)}`);
      const sent = await checkOne(a, raced.out.request_id);
      assert.equal(sent.status, "sent");
      assert.equal(sent.held_minor, 900, "one hold of the gross bid");
      // Don't send replayed on the sent request (a third tab opened before): nothing moves.
      const q3 = await q1.context().newPage();
      assert.equal(await openLink(q3, raced.out.approval_url), PAGE.alreadySent, "the link now shows the decision");
      const again = await checkOne(a, raced.out.request_id);
      assert.equal(again.transitions.sent_at, sent.transitions.sent_at);
      assert.equal(again.held_minor, sent.held_minor);
    } finally {
      await closePage(q1);
    }
  });

  test("case 3: forging and guessing tokens → the expired page every time, identical to an unknown request's; nothing revealed, nothing moves", async () => {
    const { out } = await requestAwaiting(a, ol());
    const { out: other } = await requestAwaiting(a, ol());
    const before = await checkOne(a, out.request_id);
    const real = new URL(out.approval_url);
    const token = real.searchParams.get("t")!;
    const withToken = (t: string, id = out.request_id) => `${real.origin}/approve/${id}?t=${encodeURIComponent(t)}`;
    const forged = [
      token.slice(0, 10) + (token[10] === "A" ? "B" : "A") + token.slice(11), // one character changed
      new URL(other.approval_url).searchParams.get("t")!, // another request's genuine token
      token.slice(0, 42), // one character short
      `${token}A`, // one too many
      token.toUpperCase(),
      "",
      "%00",
      "x".repeat(500),
      ...Array.from({ length: 20 }, () => randomBytes(32).toString("base64url")), // guesses
    ];
    const page = await pageAs(browser, "a");
    try {
      assert.equal(await openLink(page, withToken(token, "A2H-0000")), PAGE.expired);
      const reference = await mainText(page);
      for (const t of forged) {
        const heading = await openLink(page, withToken(t));
        assert.equal(heading, PAGE.expired, `a forged token (${t.length} chars) opened the request: ${heading}`);
        const text = await mainText(page);
        assert.equal(text, reference, "the forged page differs from an unknown request's");
        assert.equal(await sendButton(page).count(), 0, "a forged link offers Send");
      }
    } finally {
      await closePage(page);
    }
    await unchanged(out.request_id, before, "forged tokens");
    // The genuine link still works for its principal.
    const mine = await pageAs(browser, "a");
    try {
      assert.equal(await openLink(mine, out.approval_url), PAGE.awaiting);
    } finally {
      await closePage(mine);
    }
  });

  test("case 5: an agent tries every MCP tool to move a request out of awaiting_approval → nothing sends it; a refused prompt needs the state minted for that request and principal", async () => {
    const { out: target } = await requestAwaiting(a, ol());
    const before = await checkOne(a, target.request_id);
    const args = ol();
    const ua = await principalClient({ url: true, token: TOKEN! });
    const ub = await principalClient({ url: true, token: TOKEN_2! });
    try {
      const round = await firstLeg(ua, args);
      assert.ok(isInputRequired(round), "a URL client is asked through URL elicitation");
      const prompted = requestIdOf(round.inputRequests!["approval"]!.params.url!);
      const roundB = await firstLeg(ub, args);
      assert.ok(isInputRequired(roundB));
      const promptedBefore = await checkOne(a, prompted);
      const state = round.requestState!;
      const tampered = state.slice(0, -2) + (state.endsWith("AA") ? "BB" : "AA");
      const attempts: [string, () => Promise<unknown>][] = [];
      for (const action of ["accept", "decline", "cancel"] as const) {
        attempts.push([`retry ${action} without state`, () => retryLeg(a, args, undefined, { action })]);
        attempts.push([`retry ${action} with a tampered state`, () => retryLeg(ua, args, tampered, { action })]);
        attempts.push([`retry ${action} with a made-up state`, () => retryLeg(ua, args, "v1.e30.AAAA", { action })]);
      }
      attempts.push(["B's state presented by A", () => retryLeg(ua, args, roundB.requestState, { action: "accept" })]);
      attempts.push(["A's state presented by B (decline)", () => retryLeg(ub, args, state, { action: "decline" })]);
      attempts.push(["accept carrying content that asks to send", () => ua.client.callTool({ name: "request_human", arguments: { ...args }, inputResponses: { approval: { action: "accept", content: { decision: "send", request_id: target.request_id } } }, requestState: state } as never, { allowInputRequired: true, timeout: 30_000 })]);
      for (const extra of [{ request_id: target.request_id }, { status: "sent" }, { approved: true }, { approval_url: target.approval_url }]) {
        attempts.push([`request_human with ${Object.keys(extra)[0]}`, () => a.client.callTool({ name: "request_human", arguments: { ...args, ...extra } }, { timeout: 30_000 })]);
      }
      attempts.push(["check_requests with a status and an id", () => a.client.callTool({ name: "check_requests", arguments: { request_id: target.request_id, status: "sent" } }, { timeout: 30_000 })]);
      attempts.push(["find_humans with the link", () => a.client.callTool({ name: "find_humans", arguments: { topic: target.approval_url.slice(0, 200), request_type: "judgment" } }, { timeout: 30_000 })]);
      attempts.push(["an unknown tool", () => a.client.callTool({ name: "approve_request", arguments: { request_id: target.request_id } }, { timeout: 30_000 })]);
      for (const [label, attempt] of attempts) {
        try {
          await attempt();
        } catch (e) {
          if (!(e instanceof ProtocolError)) throw new Error(`${label}: ${String(e)}`, { cause: e });
        }
        await unchanged(target.request_id, before, label);
        assert.deepEqual(await checkOne(a, prompted), promptedBefore, `${label} moved the request of the URL prompt`);
      }
      // The genuine accept of the prompt opens the page and nothing more.
      const accepted = await retryLeg(ua, args, state, { action: "accept" } satisfies Answer);
      assert.ok(!accepted.isError);
      assert.equal((await checkOne(a, prompted)).status, "awaiting_approval", "accepting the URL prompt moved the request");
      const tools = (await a.client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, ["check_requests", "find_humans", "ping", "request_human"], "a tool offers the transition");
    } finally {
      await ua.close();
      await ub.close();
    }
  });
});

