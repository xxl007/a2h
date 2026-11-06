// The expiries, live (m2-approval-page): an approval link lasts at least
// fifteen minutes (design D2), so watching one expire takes that long.
// Opt-in, A2H_LONG_FLOWS=1: the verify job starts this file in the
// background right after the sign-in, before the other suites, and collects
// it at the end (about 23 minutes in all). Scenarios:
//   protocol/request-approval   Link expires unused
//   protocol/request-lifecycle  Approval link expiry by the platform,
//                               Expiry by the platform
//   platform/participant-simulation  Silent until expiry
// Handle: sim-hb-1f7d (silent persona, latency 5 min: the shortest expiry the
// rules accept); no other suite sends to it or checks it. One request is
// sent (judgment, gross €44.00 held, released at its expiry).
// Run: A2H_LONG_FLOWS=1 A2H_MCP_URL=… A2H_TOKEN=… A2H_SESSION_STATE=… node --test contract/approval-expiry.test.ts
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser } from "@playwright/test";
import { budgetGuard, checkOne, iso, manifest, principalClient, requestAwaiting, seeded, serverNow, untilStatusNot, type A2hClient, type Awaiting } from "./a2h.ts";
import { closePage, decide, launch, mainText, openLink, PAGE, pageAs, pageSkip } from "../lib/approval-page.ts";

const SECOND = 1000;
const HB = "sim-hb-1f7d";
const HB_LATENCY = seeded(HB).rules.latency_promise_seconds;
/** The link's shortest life (protocol APPROVAL_LINK_MIN_SECONDS) plus 30 s of margin. */
const LINK_SECONDS = 15 * 60 + 30;
/** The worker's expiry job runs every minute; allow it a minute and a half after the due time. */
const JOB_SLACK_S = 90;

const LONG = process.env["A2H_LONG_FLOWS"] === "1" ? false : "opt-in A2H_LONG_FLOWS=1: takes about 23 minutes (the verify job runs it in the background)";
const SKIP = LONG || pageSkip("a") || (HB_LATENCY <= 15 * 60 ? false : `the seed gives ${HB} a ${HB_LATENCY} s latency promise: the expiries cannot be watched in a bounded run`);

describe("expiries of the approval link and of a sent request (live, long)", { skip: SKIP, timeout: 30 * 60 * SECOND }, async () => {
  let c: A2hClient;
  let browser: Browser;
  let guard: string | false = false;
  if (!SKIP) {
    const g = await principalClient();
    guard = await budgetGuard(g, 4400, 1);
    await g.close();
  }
  let unused: Awaiting | undefined;
  let silent: { id: string; expiresAt: string } | undefined;

  before(async () => {
    c = await principalClient();
    browser = await launch();
    // Both at once, so their waits overlap: the request expires a latency promise after its link.
    const expiresAt = iso(new Date(serverNow().getTime() + (HB_LATENCY + LINK_SECONDS) * SECOND));
    const args = manifest(HB, "judgment", 4400, "Does this dispensing checklist match current hospital pharmacy practice?", { expires_at: expiresAt });
    unused = await requestAwaiting(c, args);
    if (!guard) {
      const toSend = await requestAwaiting(c, args);
      const page = await pageAs(browser, "a");
      try {
        await openLink(page, toSend.out.approval_url);
        assert.equal((await decide(page, "send")).heading, PAGE.sent);
      } finally {
        await closePage(page);
      }
      silent = { id: toSend.out.request_id, expiresAt };
    }
  });
  after(async () => {
    await c?.close();
    await browser?.close();
  });

  test("Scenario: Link expires unused, Scenario: Approval link expiry by the platform", { timeout: 25 * 60 * SECOND }, async () => {
    assert.ok(unused, "the request was not recorded");
    const id = unused.out.request_id;
    const due = Date.parse(unused.out.approval_expires_at);
    // Nothing happens before the link's expiry.
    await sleep(Math.max(0, due - Date.now() - 60 * SECOND));
    assert.equal((await checkOne(c, id)).status, "awaiting_approval", "still awaiting a minute before the link expires");
    const r = await untilStatusNot(c, id, ["awaiting_approval"], due - Date.now() + JOB_SLACK_S * SECOND, 10 * SECOND);
    assert.equal(r.status, "not_sent");
    assert.equal(r.reason, "expired");
    assert.equal(r.held_minor, undefined, "no hold ever existed");
    assert.equal(r.hold_status, "none");
    assert.deepEqual(Object.keys(r.transitions).sort(), ["awaiting_approval_at", "not_sent_at"], "never sent, never delivered");
    const lateS = (Date.parse(r.transitions.not_sent_at!) - due) / SECOND;
    assert.ok(lateS >= 0 && lateS <= JOB_SLACK_S, `moved ${lateS} s after the link's expiry`);
    // Opening the link shows that it expired, and nothing of the request.
    const page = await pageAs(browser, "a");
    try {
      assert.equal(await openLink(page, unused.out.approval_url), PAGE.expired);
      assert.ok(!(await mainText(page)).includes(id), "the expired page names the request");
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Expiry by the platform, Scenario: Silent until expiry", { timeout: 30 * 60 * SECOND }, async (t) => {
    if (guard) {
      t.skip(guard);
      return;
    }
    assert.ok(silent, "the silent request was not sent");
    const due = Date.parse(silent.expiresAt);
    await sleep(Math.max(0, due - Date.now() - 60 * SECOND));
    const r = await untilStatusNot(c, silent.id, ["sent"], due - Date.now() + JOB_SLACK_S * SECOND, 10 * SECOND);
    assert.equal(r.status, "expired", "the silent persona never responds: the request expires");
    assert.equal(r.transitions.accepted_at, undefined);
    const lateS = (Date.parse(r.transitions.expired_at!) - due) / SECOND;
    assert.ok(lateS >= 0 && lateS <= JOB_SLACK_S, `expired ${lateS} s after its expiry time`);
    assert.equal(r.hold_status, "released", "the held amount is reported as released");
    assert.equal(r.cleared_minor, undefined);
  });
});
