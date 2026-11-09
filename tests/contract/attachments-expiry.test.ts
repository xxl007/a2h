// Files, the scenarios that take minutes (m2-attachments task 6.1), live.
// Opt-in, A2H_LONG_FLOWS=1: the preview's verify job starts this file in the
// background with the other expiry flows and collects it at the end. The
// tests run concurrently (about 17 minutes in all). Scenarios:
//   platform/attachments  Old link (a file link used after its 5 minutes),
//                         Scan does not finish (no result 10 minutes after
//                         upload → refused as not checked, deleted),
//                         Link expires (the approval link of a request with a
//                         file expires unused → the file is deleted)
// "Scan does not finish" on a deployed stage: the browser's upload is
// answered by the test (nothing reaches storage, so no scan can ever come);
// on the local stage also a stored file whose result the fake scanner
// withholds (local/fake-scanner.ts SCAN_WITHHOLD_MARKER), and its object is
// seen deleted. "Link expires": the deletion is seen on the local stage; on a
// deployed stage the request is seen not sent and its page offers no file
// (the worker's deletion is apps/worker/test/files.test.ts "Link expires").
// Handle: sim-ol-6a23 (latency 4 h: an expiry 4 h 15.5 min out gives a
// 15.5-minute link). Nothing is sent.
// Run: A2H_LONG_FLOWS=1 A2H_MCP_URL=… A2H_TOKEN=… A2H_SESSION_STATE=… node --test contract/attachments-expiry.test.ts
import { after, before, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser } from "@playwright/test";
import { checkOne, grossReserve, manifest, principalClient, requestAwaiting, shortestExpiry, until, untilStatusNot, type A2hClient } from "./a2h.ts";
import { closePage, launch, localLink, mainText, openLink, PAGE, pageAs, pageSkip } from "../lib/approval-page.ts";
import { addFiles, afterCheck, COPY, F, fetchLink, holdBrowserUploads, LOCAL_S3, localObjects, openedLink, pillOf, rowText, type Outcome } from "../lib/files.ts";
import { SCAN_WITHHOLD_MARKER } from "../local/fake-scanner.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const OL = "sim-ol-6a23";
const OL_BID = grossReserve(OL, "verification", 20);
const LONG = process.env["A2H_LONG_FLOWS"] === "1" ? false : "opt-in A2H_LONG_FLOWS=1: takes about 17 minutes (the verify job runs it in the background)";
const SKIP = LONG || pageSkip("a");
/** The worker's sweep runs every minute; allow it two after the due time. */
const SWEEP_SLACK = 2 * MINUTE;

function need(t: TestContext, o: Outcome): o is Extract<Outcome, { kind: "pill" }> {
  if (o.kind === "skip") {
    t.skip(o.reason);
    return false;
  }
  return true;
}

describe("files, long flows (m2-attachments, live)", { skip: SKIP, concurrency: true, timeout: 25 * MINUTE }, () => {
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

  test("Scenario: Old link: a file link used after its 5 minutes is refused by storage", async (t) => {
    const page = await pageAs(browser, "a");
    try {
      const r = await requestAwaiting(c, manifest(OL, "verification", OL_BID, "Is the attached chart readable in greyscale?"));
      await openLink(page, r.out.approval_url);
      await addFiles(page, [F.png()]);
      const o = await afterCheck(page, "chart.png");
      if (!need(t, o)) return;
      assert.equal(o.pill, "Ready", o.text);
      const link = await openedLink(page, "chart.png");
      const issued = Date.now();
      assert.equal((await fetchLink(link)).status, 200, "the fresh link works");
      await sleep(Math.max(0, issued + 5 * MINUTE + 5 * SECOND - Date.now()));
      const old = await fetchLink(link);
      assert.equal(old.status, 403, `a 5-minute link used after 5 minutes: ${old.status}`);
      assert.match(old.message ?? "", /expired/i, `refused for another reason: ${old.code}`);
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Scan does not finish: no result 10 minutes after upload → refused as not checked (and deleted)", async () => {
    const page = await pageAs(browser, "a");
    try {
      const r = await requestAwaiting(c, manifest(OL, "verification", OL_BID, "Is the attached form complete?"));
      await openLink(page, r.out.approval_url);
      // Nothing reaches storage: the page believes its upload succeeded, so no scan can ever come.
      const release = await holdBrowserUploads(page, new URL(localLink(r.out.approval_url)).origin);
      await addFiles(page, [F.pdf()]);
      await release();
      // On the local stage, also a stored file whose result the fake scanner withholds.
      const withheld = { name: "withheld.txt", mimeType: "text/plain", buffer: Buffer.from(`notes\n${SCAN_WITHHOLD_MARKER}\n`) };
      if (LOCAL_S3) await addFiles(page, [withheld]);
      const added = Date.now();
      await sleep(9 * MINUTE);
      for (const name of LOCAL_S3 ? ["leaflet.pdf", "withheld.txt"] : ["leaflet.pdf"]) {
        assert.notEqual(await pillOf(page, name), "Refused", `${name} refused before 10 minutes`);
      }
      for (const name of LOCAL_S3 ? ["leaflet.pdf", "withheld.txt"] : ["leaflet.pdf"]) {
        await until(`${name} refused as not checked`, Math.max(0, added + 10 * MINUTE + SWEEP_SLACK - Date.now()), async () => ((await pillOf(page, name)) === "Refused" ? true : undefined), 5 * SECOND);
        assert.ok((await rowText(page, name)).includes(COPY.refusedNotChecked), await rowText(page, name));
      }
      const objects = await localObjects(r.out.request_id);
      if (objects) assert.deepEqual(objects, [], "the unchecked file is deleted");
      assert.ok((await mainText(page)).includes("Remove the 2 refused files to send.") || (await mainText(page)).includes("Remove the refused file to send."));
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Link expires: the approval link of a request with a file expires unused → not sent, the file deleted", async () => {
    const page = await pageAs(browser, "a");
    try {
      const r = await requestAwaiting(c, manifest(OL, "verification", OL_BID, "Is the attached notice clear?", { expires_at: shortestExpiry(OL, 15 * 60 + 30) }));
      await openLink(page, r.out.approval_url);
      await addFiles(page, [F.text()]);
      // Stored where the stage stores uploads; otherwise the row alone (refused upload_failed): the request still has a file.
      await sleep(30 * SECOND);
      if (LOCAL_S3) assert.ok((await localObjects(r.out.request_id))!.length > 0, "the file is stored before the link expires");
      const due = Date.parse(r.out.approval_expires_at);
      await sleep(Math.max(0, due - Date.now()));
      const nr = await untilStatusNot(c, r.out.request_id, ["awaiting_approval"], 90 * SECOND, 10 * SECOND);
      assert.equal(nr.status, "not_sent");
      assert.equal(nr.reason, "expired");
      assert.deepEqual(nr.files, []);
      assert.equal(await openLink(page, r.out.approval_url), PAGE.expired);
      assert.ok(!(await mainText(page)).includes("notes-clean.txt"), "the expired page shows no file");
      if (LOCAL_S3) {
        await until("the file's objects to be deleted", SWEEP_SLACK, async () => ((await localObjects(r.out.request_id))!.length === 0 ? true : undefined), 5 * SECOND);
      }
      assert.equal((await checkOne(c, r.out.request_id)).status, "not_sent");
    } finally {
      await closePage(page);
    }
  });
});
