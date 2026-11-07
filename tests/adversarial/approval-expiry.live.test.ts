// Adversarial case 4, live (m2-approval-page task 6.2): sending after the
// approval link has expired. The principal opens the page while the link is
// valid and leaves it open; past the link's expiry the page's Send must not
// send (design D6: the page checks the expiry itself, so a late minute job
// never lets a stale link send). The link lasts at least fifteen minutes, so
// this is opt-in, A2H_LONG_FLOWS=1: the verify job starts it in the
// background with contract/approval-expiry.test.ts and collects it at the
// end. Red first: approval.local.test.ts case 4 against a weakened check.
// Handle: sim-hb-1f7d (latency 5 min); nothing is sent.
// Run: A2H_LONG_FLOWS=1 A2H_MCP_URL=… A2H_TOKEN=… A2H_SESSION_STATE=… node --test adversarial/approval-expiry.live.test.ts
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser } from "@playwright/test";
import { checkOne, iso, manifest, principalClient, requestAwaiting, seeded, serverNow, type A2hClient } from "../contract/a2h.ts";
import { closePage, decide, launch, openLink, PAGE, pageAs, pageSkip } from "../lib/approval-page.ts";

const SECOND = 1000;
const HB = "sim-hb-1f7d";
const HB_LATENCY = seeded(HB).rules.latency_promise_seconds;
const LINK_SECONDS = 15 * 60 + 30;
const LONG = process.env["A2H_LONG_FLOWS"] === "1" ? false : "opt-in A2H_LONG_FLOWS=1: takes about 17 minutes (the verify job runs it in the background)";
const SKIP = LONG || pageSkip("a") || (HB_LATENCY <= 15 * 60 ? false : `the seed gives ${HB} a ${HB_LATENCY} s latency promise`);

describe("adversarial case 4: sending after the link has expired (live, long)", { skip: SKIP, timeout: 25 * 60 * SECOND }, () => {
  let c: A2hClient;
  let browser: Browser;
  before(async () => {
    c = await principalClient();
    browser = await launch();
  });
  after(async () => {
    await c?.close();
    await browser?.close();
  });

  test("case 4: Send and Don't send on a page opened while the link was valid, pressed after it expired → the expired page; the request is not_sent (expired), never sent, nothing held", { timeout: 25 * 60 * SECOND }, async () => {
    const expiresAt = iso(new Date(serverNow().getTime() + (HB_LATENCY + LINK_SECONDS) * SECOND));
    const { out } = await requestAwaiting(c, manifest(HB, "judgment", 4400, "Is this ward's medicine round checklist in the right order?", { expires_at: expiresAt }));
    const due = Date.parse(out.approval_expires_at);
    // Opened in time: the page offers Send. Two tabs, both left open.
    const sendTab = await pageAs(browser, "a");
    try {
      const dontTab = await sendTab.context().newPage();
      for (const p of [sendTab, dontTab]) assert.equal(await openLink(p, out.approval_url), PAGE.awaiting);
      // Two seconds past the link's expiry, before the worker's minute job is likely to have run.
      await sleep(Math.max(0, due - Date.now() + 2 * SECOND));
      const sent = await decide(sendTab, "send");
      assert.equal(sent.heading, PAGE.expired, `Send after expiry → ${sent.heading}`);
      const dont = await decide(dontTab, "dont_send");
      assert.equal(dont.heading, PAGE.expired, `Don't send after expiry → ${dont.heading}`);
      // The original link, opened again: still the expired page.
      assert.equal(await openLink(sendTab, out.approval_url), PAGE.expired);
    } finally {
      await closePage(sendTab);
    }
    const r = await checkOne(c, out.request_id);
    assert.equal(r.status, "not_sent", "a stale link never sends");
    assert.equal(r.reason, "expired");
    assert.equal(r.held_minor, undefined);
    assert.equal(r.hold_status, "none");
    assert.equal(r.transitions.sent_at, undefined, "never sent, never delivered");
  });
});
