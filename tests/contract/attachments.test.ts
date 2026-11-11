// Files on a real request, live (m2-attachments task 6.1): request_human
// returns the link, the QA principal adds files on the approval page
// (tests/lib/files.ts), and check_requests reports what the agent may know.
// Test names are the spec's scenarios, from the four deltas:
//   platform/attachments        Allowed file, Type not allowed, Name and
//                               content disagree, Too large, Too many, Clean
//                               file, Malicious file, Principal opens their
//                               file, Another account, Agent checks a request
//                               with files, Don't send, Sent files are fixed
//   platform/approval-page      Add and send, Send waits for checking,
//                               Refused file blocks Send until removed,
//                               Remove a file, Files on a sent request
//   protocol/request-approval   Participant does not accept files, Files over
//                               the participant's total, Removing the files
//                               makes it sendable, Request without files is
//                               unaffected
//   protocol/schemas            Request with files, Request without files
// The long ones (Old link, Link expires, Scan does not finish) are in
// attachments-expiry.test.ts (A2H_LONG_FLOWS=1); "Attachments from the
// agent" is in request-approval.test.ts; "Keyboard and phone", "Logs of an
// upload", "Setting present" and "Rules without the setting" are mapped in
// tests/README.md ("Scenario to test map: m2-attachments").
//
// What a stage must offer (tests/lib/files.ts): storage (the bucket's POST
// CORS for the web origin) and checks (a scan result). Missing either, the
// tests that need it are skipped with the reason, unless
// A2H_E2E_REQUIRE_FILE_STORAGE=1 / A2H_E2E_REQUIRE_FILE_CHECKS=1 (the verify
// jobs set them when the stage offers them; then a missing one fails).
// "Too large", "Too many" and "Type not allowed" (declared types) need
// neither and run on every stage.
//
// Handles: sim-ol-6a23 (accepts files up to 5 MB in all; verification net
// 2500 → gross 3125), sim-th-2a91 (refuses files; verification net 3500 →
// gross 4375). Three requests are sent per run (about €106 held, cleared at
// the reserve by the prompt personas); the others end with Don't send.
// Run: A2H_MCP_URL=… A2H_TOKEN=… A2H_SESSION_STATE=… A2H_SESSION_STATE_2=… node --test contract/attachments.test.ts
import { after, before, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { budgetGuard, checkOne, grossReserve, manifest, principalClient, requestAwaiting, untilStatusNot, until, type A2hClient, type Awaiting } from "./a2h.ts";
import { closePage, decide, heading, launch, localLink, mainText, openLink, PAGE, pageAs, pageSkip, sendButton } from "../lib/approval-page.ts";
import {
  addFiles,
  addOf,
  afterCheck,
  afterUpload,
  captureAction,
  COPY,
  ELSEWHERE,
  F,
  fetchLink,
  fileIdOf,
  files,
  holdBrowserUploads,
  KB,
  localObjects,
  MB,
  openedLink,
  pdfOfSize,
  pillOf,
  pngOfSize,
  redact,
  replayAction,
  rowText,
  textOfSize,
  type Outcome,
} from "../lib/files.ts";

const SECOND = 1000;
const FEE_PERCENT = 20; // checked live by discovery.test.ts "Gross reserve with fee metadata"
const OL = "sim-ol-6a23";
const TH = "sim-th-2a91";
const OL_BID = grossReserve(OL, "verification", FEE_PERCENT);
const TH_BID = grossReserve(TH, "verification", FEE_PERCENT);
/**
 * "Add and send" and "Remove a file" Send to a participant who accepts files;
 * who, and the amount, play no part. sim-jw-9e48 (prompt persona, files
 * accepted by default) on its cheapest lane: opinion at the gross reserve,
 * €7.50 against sim-ol-6a23's €31.25, so the file step fits the per-run
 * principal's budget (issue #114). "Participant does not accept files" keeps
 * sim-th-2a91, the one participant that refuses files; the scenarios that
 * never Send stay on sim-ol-6a23 (an awaiting request holds nothing), and
 * "Files over the participant's total" needs its 5 MB total.
 */
const JW = "sim-jw-9e48";
const JW_BID = grossReserve(JW, "opinion", FEE_PERCENT);
const POLL = { format: "poll", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] };
const PAGE_A = pageSkip("a");
const PAGE_AB = pageSkip("a", "b");
const LOG_FILES = (process.env["A2H_LOCAL_LOG_FILES"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Skips the test (with the stage's reason) when the outcome says the stage cannot do it. */
function need(t: TestContext, o: Outcome): o is Extract<Outcome, { kind: "pill" }> {
  if (o.kind === "skip") {
    t.skip(o.reason);
    return false;
  }
  return true;
}

const webOrigin = (link: string) => new URL(localLink(link)).origin;

describe("files on a real request (m2-attachments, live)", { skip: ELSEWHERE || PAGE_A, timeout: 30 * 60 * SECOND }, () => {
  let c: A2hClient;
  let browser: Browser;
  let guard: string | false = false;

  before(async () => {
    c = await principalClient();
    browser = await launch();
    // Spends: "Add and send" and "Remove a file" one request each to JW, "Participant does not accept files" one to TH.
    guard = await budgetGuard(c, 2 * JW_BID + TH_BID, 3);
  });
  after(async () => {
    await c?.close();
    await browser?.close();
  });

  async function awaitingOn(page: Page, handle: string, question: string): Promise<Awaiting> {
    const a = await requestAwaiting(
      c,
      handle === JW ? manifest(JW, "opinion", JW_BID, question, POLL) : manifest(handle, "verification", handle === OL ? OL_BID : TH_BID, question),
    );
    assert.equal(await openLink(page, a.out.approval_url), PAGE.awaiting);
    return a;
  }

  async function dontSend(page: Page): Promise<void> {
    if ((await heading(page)) === PAGE.awaiting) assert.equal((await decide(page, "dont_send")).heading, PAGE.notSent);
  }

  test("Scenario: Request without files (protocol/schemas): its summary carries zero files", async () => {
    const a = await requestAwaiting(c, manifest(OL, "verification", OL_BID, "Does this checkout page meet WCAG 2.2 AA for focus visibility?"));
    const r = await checkOne(c, a.out.request_id);
    assert.deepEqual(r.files, [], "a request without files reports zero files");
    const page = await pageAs(browser, "a");
    try {
      await openLink(page, a.out.approval_url);
      await dontSend(page);
    } finally {
      await closePage(page);
    }
    assert.deepEqual((await checkOne(c, a.out.request_id)).files, []);
  });

  test("Scenario: Agent checks a request with files, Scenario: Request with files (protocol/schemas), Scenario: Allowed file, Scenario: Clean file, Scenario: Add and send, Scenario: Send waits for checking, Scenario: Files on a sent request, Scenario: Sent files are fixed", async (t) => {
    if (guard) return t.skip(guard);
    const page = await pageAs(browser, "a");
    try {
      const a = await awaitingOn(page, JW, "Is the colour contrast of the attached leaflet and chart sufficient for low-vision readers?");
      const pdf = pdfOfSize(2 * MB, "leaflet.pdf");
      const png = pngOfSize(300 * KB, "chart.png");
      const add = await captureAction(page, addOf("leaflet.pdf"), () => addFiles(page, [pdf, png]));
      // Send waits: unavailable, with the reason next to it, while anything uploads or is checked.
      assert.equal(await sendButton(page).isDisabled(), true, "Send is available while files upload");
      const gate = await mainText(page);
      assert.ok(gate.includes(COPY.gateUploading) || gate.includes(COPY.gateChecking), "the page says why Send is unavailable");

      // Allowed file: accepted, type and size recorded, then the malware check.
      const p = await afterCheck(page, "leaflet.pdf");
      if (!need(t, p)) return;
      assert.equal(p.pill, "Ready", `leaflet.pdf: ${p.text}`);
      assert.match(p.text, /PDF · 2 MB/);
      const q = await afterCheck(page, "chart.png");
      if (!need(t, q)) return;
      assert.equal(q.pill, "Ready", `chart.png: ${q.text}`);
      assert.equal(await sendButton(page).isEnabled(), true, "Send available once every file is ready");
      assert.match(await files.announcer(page).innerText(), /Every file is ready\. Send is available\.|is ready\./);

      const sent = await decide(page, "send");
      assert.equal(sent.heading, PAGE.sent, sent.alerts.join(" | "));
      assert.deepEqual(await files.sentList(page).getByRole("listitem").allInnerTexts().then((x) => x.map((s) => s.split("\n")[0])), ["leaflet.pdf", "chart.png"]);

      // The agent's view: two files, type and size, in the order attached; no name, no link.
      const raw = await c.client.callTool({ name: "check_requests", arguments: { request_id: a.out.request_id } }, { timeout: 30_000 });
      const r = await checkOne(c, a.out.request_id);
      assert.equal(r.status === "sent" || r.status === "accepted" || r.status === "answered", true, r.status);
      assert.deepEqual(r.files, [
        { media_type: "application/pdf", size_bytes: 2 * MB },
        { media_type: "image/png", size_bytes: 300 * KB },
      ]);
      const everything = JSON.stringify(raw);
      for (const leak of ["leaflet", "chart", "X-Amz", "amazonaws", "/files/", "tmp/", "uploads/"]) assert.ok(!everything.includes(leak), `check_requests carries ${leak}`);
      assert.match(everything, /2 attached by the principal \(application\/pdf, image\/png\)/);

      // Files on a sent request: listed, openable, fixed.
      assert.equal(await openLink(page, a.out.approval_url), PAGE.alreadySent);
      assert.equal(await files.sentList(page).getByRole("listitem").count(), 2);
      const link = await openedLink(page, "leaflet.pdf");
      const got = await fetchLink(link);
      assert.equal(got.status, 200);
      assert.ok(got.body.equals(pdf.buffer), "the sent file is the uploaded file, byte for byte");
      assert.equal(await page.getByRole("button", { name: /^Remove/ }).count(), 0, "no Remove on a sent request");
      assert.equal(await files.choose(page).count(), 0, "no Choose files on a sent request");

      // Sent files are fixed: the page's own add and remove, replayed on the sent request, change nothing.
      const fileId = fileIdOf(add.result);
      assert.ok(fileId, "the add action returned the file");
      const again = await replayAction(page, add.action, [a.out.request_id, { name: "late.pdf", type: "application/pdf", size: 1000 }]);
      assert.equal(again?.["kind"], "unavailable", `add after Send: ${JSON.stringify(redact(again))}`);
      // Remove after a decision: "Remove a file" below (it needs the remove action's id).
      const after = await checkOne(c, a.out.request_id);
      assert.deepEqual(after.files, r.files, "the files of a sent request never change");
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Remove a file, Scenario: Sent files are fixed (remove after Send)", async (t) => {
    const page = await pageAs(browser, "a");
    try {
      const a = await awaitingOn(page, JW, "Do the headings in the attached summary follow a logical order for screen-reader users?");
      await addFiles(page, [F.markdown(), F.pdf()]);
      const up = await afterUpload(page, "summary.md");
      if (!need(t, up)) return;
      const ready = await afterCheck(page, "summary.md");
      // Remove works on a ready file, or on one still checking where the stage checks nothing.
      if (ready.kind === "pill") assert.equal(ready.pill, "Ready", ready.text);
      const removed = await captureAction(page, (args) => args.length === 2 && typeof args[1] === "string", () => files.remove(page, "summary.md").click());
      assert.equal(removed.result?.["kind"], "removed");
      await until("the row to go", 15_000, async () => ((await files.row(page, "summary.md").count()) === 0 ? true : undefined), 300);
      assert.match(await files.announcer(page).innerText(), /summary\.md removed\./);
      await page.reload();
      assert.equal(await files.list(page).getByRole("listitem").count(), 1, "after a reload only the other file is listed");
      assert.equal(await files.row(page, "summary.md").count(), 0);
      const objects = await localObjects(a.out.request_id);
      if (objects) assert.ok(!objects.some((k) => k.endsWith(String(removed.args[1]))), "the removed file's object is deleted at once");

      // The other one too, then Send: the request goes with zero files (a removed file is not part of it).
      if (!need(t, await afterUpload(page, "leaflet.pdf"))) return;
      await files.remove(page, "leaflet.pdf").click();
      await until("the row to go", 15_000, async () => ((await files.row(page, "leaflet.pdf").count()) === 0 ? true : undefined), 300);
      if (guard) {
        await dontSend(page);
        return t.skip(`the Send half: ${guard}`);
      }
      const sent = await decide(page, "send");
      assert.equal(sent.heading, PAGE.sent, sent.alerts.join(" | "));
      const s = await checkOne(c, a.out.request_id);
      assert.notEqual(s.status, "awaiting_approval");
      assert.deepEqual(s.files, [], "the sent request has zero files");

      // Sent files are fixed: a removed file's remove, replayed after Send, is refused and changes nothing.
      const late = await replayAction(page, removed.action, [a.out.request_id, String(removed.args[1])]);
      assert.equal(late?.["kind"], "unavailable", `remove after Send: ${JSON.stringify(redact(late))}`);
      assert.deepEqual((await checkOne(c, a.out.request_id)).files, []);
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Type not allowed (declared: a ZIP archive and an executable; the request's other files unaffected)", async () => {
    const page = await pageAs(browser, "a");
    try {
      const a = await awaitingOn(page, OL, "Is the attached form usable with a keyboard alone?");
      const unhold = await holdBrowserUploads(page, webOrigin(a.out.approval_url));
      await addFiles(page, [F.pdf()]);
      await addFiles(page, [F.zip(), F.exe()]);
      for (const name of ["bundle.zip", "setup.exe"]) {
        await until(`${name} refused`, 30_000, async () => ((await pillOf(page, name)) === "Refused" ? true : undefined), 300);
        assert.ok((await rowText(page, name)).includes(COPY.refusedType), `${name}: ${await rowText(page, name)}`);
      }
      assert.notEqual(await pillOf(page, "leaflet.pdf"), "Refused", "the request's other file is unaffected");
      await unhold();
      await dontSend(page);
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Name and content disagree (report.pdf holding an HTML document), Scenario: Refused file blocks Send until removed", async (t) => {
    const page = await pageAs(browser, "a");
    try {
      await awaitingOn(page, OL, "Is the attached report readable with text enlarged to 200 %?");
      await addFiles(page, [F.disguisedHtml()]);
      const o = await afterCheck(page, "report.pdf");
      if (!need(t, o)) return;
      assert.equal(o.pill, "Refused", o.text);
      assert.ok(o.text.includes(COPY.refusedType), o.text);
      assert.equal(await sendButton(page).isDisabled(), true, "Send unavailable while a refused file is listed");
      assert.ok((await mainText(page)).includes("Remove the refused file to send."));
      await files.remove(page, "report.pdf").click();
      await until("Send to come back", 15_000, async () => ((await sendButton(page).isEnabled()) ? true : undefined), 300);
      await dontSend(page);
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Too large (a file over 25 MB; a file taking the request over 50 MB): refused before anything is stored, the limit stated", async () => {
    const page = await pageAs(browser, "a");
    try {
      const a = await awaitingOn(page, OL, "Are the tables in the attached audit export accessible?");
      // Nothing is sent to storage here: the browser's uploads are answered by the test (declared sizes are what the limits read).
      const unhold = await holdBrowserUploads(page, webOrigin(a.out.approval_url));
      const big = { name: "minutes-big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(25 * MB + 1, 0x20) };
      const added = await captureAction(page, addOf("minutes-big.pdf"), () => addFiles(page, [big]));
      assert.deepEqual(redact(added.result), { kind: "refused", refusal: "size" });
      assert.ok((await rowText(page, "minutes-big.pdf")).includes(COPY.refusedSize));
      // 20 + 20 MB recorded through the page's own add action (no upload at all: the limit reads declared sizes, and
      // a file whose upload failed would no longer count; pr-108's first run lost two held 20 MB uploads that way),
      // then 20 MB more chosen in the browser: over 50 MB in all.
      for (const name of ["part-1.pdf", "part-2.pdf"]) {
        const r = await replayAction(page, added.action, [a.out.request_id, { name, type: "application/pdf", size: 20 * MB }]);
        assert.equal(r?.["kind"], "added", `${name}: ${JSON.stringify(redact(r))}`);
      }
      const third = await captureAction(page, addOf("part-3.pdf"), () => addFiles(page, [pdfOfSize(20 * MB, "part-3.pdf")]));
      assert.deepEqual(redact(third.result), { kind: "refused", refusal: "total" });
      assert.ok((await rowText(page, "part-3.pdf")).includes(COPY.refusedTotal));
      const objects = await localObjects(a.out.request_id);
      if (objects) assert.deepEqual(objects, [], "nothing was stored for the refused files (the others were never posted)");
      await unhold();
      await dontSend(page);
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Too many: a sixth file is refused with the limit stated", async () => {
    const page = await pageAs(browser, "a");
    try {
      const a = await awaitingOn(page, OL, "Do these five screenshots show visible focus on every control?");
      const unhold = await holdBrowserUploads(page, webOrigin(a.out.approval_url));
      // Six chosen at once: the sixth is refused, by the server, with the limit stated.
      const sixth = await captureAction(page, addOf("notes-clean.txt"), () => addFiles(page, [F.pdf(), F.png(), F.jpeg(), F.webp(), F.csv(), F.text()]));
      assert.deepEqual(redact(sixth.result), { kind: "refused", refusal: "count" });
      await until("the sixth file's refusal", 15_000, async () => ((await rowText(page, "notes-clean.txt")).includes(COPY.refusedCount) ? true : undefined), 300);
      // The page then offers no way to add more, and says why; the server refuses a seventh asked for directly.
      assert.ok((await mainText(page)).includes("5 files is the most a request can have. Remove one to add another."));
      assert.equal(await files.choose(page).isDisabled(), true, "Choose files is unavailable with 5 files");
      const seventh = await replayAction(page, sixth.action, [a.out.request_id, { name: "seventh.pdf", type: "application/pdf", size: 1000 }]);
      assert.deepEqual(redact(seventh), { kind: "refused", refusal: "count" });
      await unhold();
      await dontSend(page);
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Malicious file (the EICAR test file named notes.txt), Scenario: Refused file blocks Send until removed", async (t) => {
    const page = await pageAs(browser, "a");
    try {
      const a = await awaitingOn(page, OL, "Is the attached note clear enough to follow?");
      await addFiles(page, [F.eicar()]);
      const o = await afterCheck(page, "notes.txt");
      if (!need(t, o)) return;
      assert.equal(o.pill, "Refused", o.text);
      assert.ok(o.text.includes(COPY.refusedMalware), o.text);
      const text = await mainText(page);
      for (const name of ["EICAR", "Eicar", "Test-File", "virus", "THREATS_FOUND"]) assert.ok(!text.includes(name), `the page names the detection (${name})`);
      assert.equal(await sendButton(page).isDisabled(), true);
      assert.ok(text.includes("Remove the refused file to send."));
      const objects = await localObjects(a.out.request_id);
      if (objects) assert.deepEqual(objects, [], "the flagged file is deleted");
      await files.remove(page, "notes.txt").click();
      await until("Send to come back", 15_000, async () => ((await sendButton(page).isEnabled()) ? true : undefined), 300);
      await dontSend(page);
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Principal opens their file, Scenario: Another account (nothing returned that reveals the file exists)", { skip: PAGE_AB }, async (t) => {
    const page = await pageAs(browser, "a");
    const other = await pageAs(browser, "b");
    try {
      const a = await awaitingOn(page, OL, "Is the attached chart understandable without colour?");
      const add = await captureAction(page, addOf("chart.png"), () => addFiles(page, [F.png()]));
      const o = await afterCheck(page, "chart.png");
      if (!need(t, o)) return;
      assert.equal(o.pill, "Ready", o.text);
      const fileId = fileIdOf(add.result)!;
      const opened = await captureAction(page, (args) => args.length === 2 && args[1] === fileId, async () => {
        const link = await openedLink(page, "chart.png");
        const u = new URL(link);
        assert.equal(u.searchParams.get("X-Amz-Expires"), "300", "the link works for 5 minutes at most");
        assert.ok(!link.includes("chart"), "no file name in the link");
        const got = await fetchLink(link);
        assert.equal(got.status, 200);
        assert.ok(got.body.equals(F.png().buffer), "the principal receives their file");
      });
      assert.equal(typeof opened.result?.["url"], "string");

      // B, signed in, with A's link in hand (its cookie for A's page), asks for that file's link, and for a file that does not exist.
      assert.equal(await openLink(other, a.out.approval_url), PAGE.wrongPrincipal);
      const asB = await replayAction(other, opened.action, [a.out.request_id, fileId]);
      const unknown = await replayAction(other, opened.action, [a.out.request_id, "fAAAAAAAAAAAAAAAAAAAAAA"]);
      assert.deepEqual(redact(asB), { url: null }, "B gets nothing");
      assert.deepEqual(redact(unknown), redact(asB), "the answer for A's file is the answer for no file");
      assert.ok(!(await mainText(other)).includes("chart.png"), "B's page does not list A's file");
      await dontSend(page);
    } finally {
      await closePage(page);
      await closePage(other);
    }
  });

  test("Scenario: Participant does not accept files, Scenario: Removing the files makes it sendable, Scenario: Request without files is unaffected", async (t) => {
    if (guard) return t.skip(guard);
    const page = await pageAs(browser, "a");
    try {
      const a = await awaitingOn(page, TH, "Does the attached title plan show a restrictive covenant on the garden?");
      await addFiles(page, [F.pdf()]);
      const o = await afterCheck(page, "leaflet.pdf");
      if (!need(t, o)) return;
      assert.equal(o.pill, "Ready", o.text);
      const refused = await decide(page, "send");
      assert.equal(refused.heading, PAGE.awaiting, "Send refused: the request stays awaiting approval");
      const alert = refused.alerts.join(" ");
      assert.ok(alert.includes(COPY.rulesTitle), alert);
      for (const rule of ["accepted", "max_total", "0 bytes", "0 MB", "does not accept", "doesn't accept"]) assert.ok(!alert.includes(rule), `the page names the rule (${rule})`);
      const r = await checkOne(c, a.out.request_id);
      assert.equal(r.status, "awaiting_approval");
      assert.equal(r.hold_status, "none", "nothing held");
      assert.equal(await files.row(page, "leaflet.pdf").count(), 1, "the file is still listed");

      // Removing the files makes it sendable; the setting plays no part without files.
      await files.remove(page, "leaflet.pdf").click();
      await until("the row to go", 15_000, async () => ((await files.row(page, "leaflet.pdf").count()) === 0 ? true : undefined), 300);
      const sent = await decide(page, "send");
      assert.equal(sent.heading, PAGE.sent, sent.alerts.join(" | "));
      const s = await checkOne(c, a.out.request_id);
      assert.notEqual(s.status, "awaiting_approval");
      assert.deepEqual(s.files, []);
    } finally {
      await closePage(page);
    }
  });

  test("Scenario: Files over the participant's total, Scenario: Don't send (two files deleted, their links stop working)", async (t) => {
    const page = await pageAs(browser, "a");
    try {
      const a = await awaitingOn(page, OL, "Do the two attached transcripts use plain language throughout?");
      // sim-ol-6a23 accepts up to 5 MB in all: 3 MB + 2.5 MB is over.
      await addFiles(page, [textOfSize(3 * MB, "transcript-1.txt"), textOfSize(2.5 * MB, "transcript-2.txt")]);
      for (const name of ["transcript-1.txt", "transcript-2.txt"]) {
        const o = await afterCheck(page, name);
        if (!need(t, o)) return;
        assert.equal(o.pill, "Ready", o.text);
      }
      const refused = await decide(page, "send");
      assert.equal(refused.heading, PAGE.awaiting);
      assert.ok(refused.alerts.join(" ").includes(COPY.rulesTitle), refused.alerts.join(" "));
      assert.ok(!refused.alerts.join(" ").includes("5 MB"), "the participant's total is not stated");
      assert.equal((await checkOne(c, a.out.request_id)).status, "awaiting_approval");

      // Don't send: both files go within the hour (the worker's sweep runs every minute); their links stop working.
      const links = [await openedLink(page, "transcript-1.txt"), await openedLink(page, "transcript-2.txt")];
      const signedAt = Date.now();
      for (const l of links) assert.equal((await fetchLink(l)).status, 200);
      assert.equal((await decide(page, "dont_send")).heading, PAGE.notSent);
      assert.ok((await mainText(page)).includes("The files you added will be deleted within the hour."));
      // Bound: before the links' own 5 minutes run out, so that a refusal means the objects are gone, not an expired link.
      for (const l of links) {
        const gone = await until("a deleted file's link to stop working", 270_000 - (Date.now() - signedAt), async () => {
          const r = await fetchLink(l);
          return r.status === 200 ? undefined : r;
        }, 5_000);
        assert.ok(gone.status === 404 || gone.status === 403, `status ${gone.status}`);
        assert.ok(!/expired/i.test(gone.message ?? ""), `refused as expired, not as deleted: ${gone.code}`);
      }
      const objects = await localObjects(a.out.request_id);
      if (objects) assert.deepEqual(objects, []);
      const r = await untilStatusNot(c, a.out.request_id, ["awaiting_approval"], 10 * SECOND);
      assert.equal(r.status, "not_sent");
      assert.deepEqual(r.files, []);
    } finally {
      await closePage(page);
    }
  });

  // Last: every log line the tests above caused. Only where the logs can be read (the local stage:
  // A2H_LOCAL_LOG_FILES, the MCP, worker and fake-scanner lines and the local web server's output);
  // a deployed stage's logs are CloudWatch's, checked by the package tests named in tests/README.md.
  test("Scenario: Logs of an upload: no log line carries a file's name or any of its content", { skip: LOG_FILES.length === 0 ? "needs A2H_LOCAL_LOG_FILES (the local stage's log files)" : false }, () => {
    const names = ["leaflet", "chart.png", "summary.md", "bundle.zip", "setup.exe", "report.pdf", "minutes-big", "part-1.pdf", "notes.txt", "notes-clean", "transcript-1", "IMG_2041", "diagram.webp", "figures.csv"];
    const content = ["Meeting notes", "month,readers", "# Summary", "Not a PDF", "%PDF-", "EICAR-STANDARD", "The quick brown fox", "IHDR"];
    for (const file of LOG_FILES) {
      const text = readFileSync(file, "utf8");
      assert.ok(/file_id|"fileId"|file added|file event/.test(text), `${file}: no file log line at all (wrong file?)`);
      for (const needle of [...names, ...content]) assert.ok(!text.includes(needle), `${file} carries "${needle}"`);
    }
  });
});
