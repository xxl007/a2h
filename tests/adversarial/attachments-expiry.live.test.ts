// Adversarial suite, files, case F2 (m2-attachments task 6.2): reusing an
// expired upload policy. A policy lasts 5 minutes (design D2), so the case
// waits that long. Opt-in, A2H_LONG_FLOWS=1: the preview's verify job runs it
// in the background with the other expiry flows. Storage is reached from
// Node (no CORS involved), so the case runs on every stage whose web role may
// write its upload area. Red first against a one-line weakening (the
// policy's expiry stretched), see tests/README.md.
// Run: A2H_LONG_FLOWS=1 A2H_MCP_URL=… A2H_TOKEN=… A2H_SESSION_STATE=… node --test adversarial/attachments-expiry.live.test.ts
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser } from "@playwright/test";
import { grossReserve, manifest, principalClient, requestAwaiting, type A2hClient } from "../contract/a2h.ts";
import { closePage, decide, launch, localLink, openLink, PAGE, pageAs, pageSkip } from "../lib/approval-page.ts";
import { addFiles, addOf, afterUpload, captureAction, F, holdBrowserUploads, policyOf, postToStorage } from "../lib/files.ts";

const SECOND = 1000;
const OL = "sim-ol-6a23";
const LONG = process.env["A2H_LONG_FLOWS"] === "1" ? false : "opt-in A2H_LONG_FLOWS=1: waits for a policy to expire (5 minutes)";
const SKIP = LONG || pageSkip("a");

describe("adversarial: an expired upload policy (m2-attachments, live, long)", { skip: SKIP, timeout: 15 * 60 * SECOND }, () => {
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

  test("case F2: reusing an expired upload policy → storage refuses it, before and after the file's own row is gone", async () => {
    const page = await pageAs(browser, "a");
    try {
      const r = await requestAwaiting(c, manifest(OL, "verification", grossReserve(OL, "verification", 20), "Is the attached floor plan readable?"));
      assert.equal(await openLink(page, r.out.approval_url), PAGE.awaiting);
      const release = await holdBrowserUploads(page, new URL(localLink(r.out.approval_url)).origin);
      const added = await captureAction(page, addOf("leaflet.pdf"), () => addFiles(page, [F.pdf()]));
      await afterUpload(page, "leaflet.pdf");
      await release();
      const policy = policyOf(added.result);
      assert.ok(policy, "the add action returned a policy");
      const issued = Date.now();
      await sleep(Math.max(0, issued + 5 * 60 * SECOND + 10 * SECOND - Date.now()));
      const late = await postToStorage(policy, F.pdf().buffer);
      assert.equal(late.status, 403, `a policy 5 minutes old stored a file: ${late.status}`);
      assert.equal(late.code, "AccessDenied");
      const expiration = JSON.parse(Buffer.from(policy.fields["Policy"]!, "base64").toString("utf8")) as { expiration: string };
      assert.ok(Date.parse(expiration.expiration) - issued <= 5 * 60 * SECOND + 5 * SECOND, `the policy lasts longer than 5 minutes: ${expiration.expiration}`);
      assert.equal((await decide(page, "dont_send")).heading, PAGE.notSent);
      const after = await postToStorage(policy, F.pdf().buffer);
      assert.equal(after.status, 403, "after Don't send");
    } finally {
      await closePage(page);
    }
  });
});
