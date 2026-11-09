// Adversarial suite, files (m2-attachments task 6.2), live: against a
// stage's approval page, its storage and its MCP endpoint. Fail closed
// expected: nothing unchecked, foreign or changed after Send ever becomes
// part of a request; no file is readable by anyone but its principal.
//
//   case F1  uploading to another principal's request
//   case F2  reusing an expired upload policy        (long: adversarial/attachments-expiry.live.test.ts)
//   case F3  a body larger than the policy, or than declared
//   case F4  content-type spoofing (policy field, declared type, bytes)
//   case F5  EICAR (through the page, and posted straight to storage)
//   case F6  reading a file by guessing its address
//   case F7  adding, removing or refusing a file after Send; re-posting a sent file
//   case F8  racing remove and Send
//
// The instruments (tests/lib/files.ts): the upload policy the page's add
// action returns, the page's own server actions replayed with other
// arguments from a signed-in browser context, and the browser's upload to
// storage answered by the test (`holdBrowserUploads`) so that the test posts
// whatever body it wants with the policy. Storage is reached from Node (no
// CORS involved): the storage cases run on any stage whose web role may write
// its upload area, previews included. The cases that need a check result
// (F3 declared size, F4 bytes, F5, F7, F8) are skipped without one unless
// A2H_E2E_REQUIRE_FILE_CHECKS=1.
//
// Each case was first run red against a one-line weakening on the local
// stage (local/stage.ts A2H_LOCAL_FILES=1 with a local `next start`), the
// weakening reverted with `git checkout` (never committed), then run green;
// the runs are quoted in the PR and the table is in tests/README.md.
// Run: A2H_MCP_URL=… A2H_TOKEN=… A2H_TOKEN_2=… A2H_SESSION_STATE=… A2H_SESSION_STATE_2=… node --test adversarial/attachments.live.test.ts
import { after, before, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Browser, Page } from "@playwright/test";
import { FILE_ID_PATTERN } from "@a2h/protocol";
import { budgetGuard, checkOne, grossReserve, manifest, principalClient, requestAwaiting, until, type A2hClient, type Awaiting } from "../contract/a2h.ts";
import { closePage, decide, heading, launch, localLink, mainText, openLink, PAGE, pageAs, pageSkip, sendButton } from "../lib/approval-page.ts";
import {
  addFiles,
  addOf,
  afterCheck,
  afterUpload,
  captureAction,
  COPY,
  ELSEWHERE,
  eicar,
  F,
  fetchLink,
  fileIdOf,
  files,
  guessObject,
  holdBrowserUploads,
  LOCAL_S3,
  localObjects,
  MB,
  NO_CHECKS,
  openedLink,
  pdfOfSize,
  pillOf,
  policyOf,
  postToStorage,
  redact,
  REQUIRE_CHECKS,
  replayAction,
  rowText,
  type Outcome,
  type UploadPolicy,
} from "../lib/files.ts";

const SECOND = 1000;
const FEE_PERCENT = 20;
const OL = "sim-ol-6a23";
const OL_BID = grossReserve(OL, "verification", FEE_PERCENT);
const PAGE_A = pageSkip("a");
const PAGE_AB = pageSkip("a", "b") || (process.env["A2H_TOKEN_2"] ? false : "needs A2H_TOKEN_2 (principal B's token)");
/** Live rounds of the race (each sends a request); the local red runs use more. */
const RACE_ROUNDS = Number(process.env["A2H_RACE_ROUNDS"] ?? 2);
/** LocalStack does not enforce bucket access for anonymous callers: the unsigned reads are a deployed stage's. */
const ANONYMOUS_ENFORCED = !LOCAL_S3;

function need(t: TestContext, o: Outcome): o is Extract<Outcome, { kind: "pill" }> {
  if (o.kind === "skip") {
    t.skip(o.reason);
    return false;
  }
  return true;
}

/** Waits for the worker's verdict on a file whose bytes the test posted itself; "skip" when no verdict comes. */
async function verdict(page: Page, name: string, waitMs = 150_000): Promise<Outcome> {
  try {
    const pill = await until(`a verdict on a posted file`, waitMs, async () => {
      const p = await pillOf(page, name);
      return p === "Ready" || p === "Refused" ? p : undefined;
    }, 1_000);
    return { kind: "pill", pill, text: await rowText(page, name) };
  } catch (e) {
    if (REQUIRE_CHECKS) throw new Error("no verdict and A2H_E2E_REQUIRE_FILE_CHECKS=1", { cause: e });
    return { kind: "skip", reason: NO_CHECKS };
  }
}

describe("adversarial: files fail closed (m2-attachments, live)", { skip: ELSEWHERE || PAGE_A, timeout: 30 * 60 * SECOND }, () => {
  let a: A2hClient;
  let b: A2hClient | undefined;
  let browser: Browser;
  let guard: string | false = false;

  before(async () => {
    a = await principalClient();
    if (process.env["A2H_TOKEN_2"]) b = await principalClient({ token: process.env["A2H_TOKEN_2"] });
    browser = await launch();
    guard = await budgetGuard(a, OL_BID * (1 + RACE_ROUNDS), 12);
  });
  after(async () => {
    await a?.close();
    await b?.close();
    await browser?.close();
  });

  async function awaitingOn(page: Page, c: A2hClient, question: string): Promise<Awaiting> {
    const r = await requestAwaiting(c, manifest(OL, "verification", OL_BID, question));
    assert.equal(await openLink(page, r.out.approval_url), PAGE.awaiting);
    return r;
  }
  const origin = (r: Awaiting) => new URL(localLink(r.out.approval_url)).origin;

  /** Adds `file` with the browser's upload held: the policy and the file id, nothing stored. */
  async function addHeld(page: Page, r: Awaiting, file: { name: string; mimeType: string; buffer: Buffer }) {
    const release = await holdBrowserUploads(page, origin(r));
    const added = await captureAction(page, addOf(file.name), () => addFiles(page, [file]));
    // Released only once the page has had its (held) upload answered.
    await afterUpload(page, file.name);
    await release();
    const policy = policyOf(added.result);
    const id = fileIdOf(added.result);
    assert.ok(policy && id, `the add action did not return a policy: ${JSON.stringify(added.result?.["kind"])}`);
    return { added, policy, id };
  }

  async function dontSend(page: Page): Promise<void> {
    if ((await heading(page)) === PAGE.awaiting) assert.equal((await decide(page, "dont_send")).heading, PAGE.notSent);
  }

  test("case F1: uploading to another principal's request → B's add on A's request is refused (with A's link in hand too); B's policy cannot be bent onto A's key; A's files unchanged", { skip: PAGE_AB }, async () => {
    const pa = await pageAs(browser, "a");
    const pb = await pageAs(browser, "b");
    try {
      const ra = await awaitingOn(pa, a, "Is the attached menu readable at arm's length?");
      const mine = await addHeld(pa, ra, F.pdf());
      const rb = await awaitingOn(pb, b!, "Is the attached flyer readable at arm's length?");
      const theirs = await addHeld(pb, rb, F.png());

      // B on B's own page, A's request id in the arguments (B's cookie holds B's token): refused.
      const viaOwnPage = await replayAction(pb, theirs.added.action, [ra.out.request_id, { name: "b.pdf", type: "application/pdf", size: 100 }]);
      assert.equal(viaOwnPage?.["kind"], "unavailable", JSON.stringify(redact(viaOwnPage)));
      // B opens A's link (B's browser now holds A's token for A's page), then adds there: refused.
      assert.equal(await openLink(pb, ra.out.approval_url), PAGE.wrongPrincipal);
      const withALink = await replayAction(pb, theirs.added.action, [ra.out.request_id, { name: "b.pdf", type: "application/pdf", size: 100 }], new URL(localLink(ra.out.approval_url)).pathname);
      assert.equal(withALink?.["kind"], "unavailable", JSON.stringify(redact(withALink)));
      // B's own policy with its key bent onto A's file: storage refuses it (the policy fixes the key).
      const bent = await postToStorage(theirs.policy, F.png().buffer, { key: mine.policy.fields["key"]! });
      assert.equal(bent.status, 403, `B's policy wrote A's key: ${bent.status} ${bent.code}`);
      assert.equal(bent.code, "AccessDenied");
      // A's request: only A's file.
      await pa.reload();
      assert.deepEqual(await files.list(pa).getByRole("listitem").allInnerTexts().then((x) => x.map((s) => s.split("\n")[0])), ["leaflet.pdf"]);
      await dontSend(pa);
      await openLink(pb, rb.out.approval_url);
      await dontSend(pb);
    } finally {
      await closePage(pa);
      await closePage(pb);
    }
  });

  test("case F3: a body larger than the policy is refused by storage; a body larger than declared is refused by the content check", async (t) => {
    const page = await pageAs(browser, "a");
    try {
      const r = await awaitingOn(page, a, "Is the attached agenda clear?");
      const small = pdfOfSize(1024, "agenda.pdf");
      const { policy, id } = await addHeld(page, r, small);
      // Over the policy's 25 MB.
      const over = await postToStorage(policy, Buffer.concat([small.buffer, Buffer.alloc(25 * MB + 1 - small.buffer.length, 0x20)]));
      assert.equal(over.status, 400, `25 MB + 1 byte stored: ${over.status}`);
      assert.equal(over.code, "EntityTooLarge");
      // Within the policy but four times what was declared (a way round the 50 MB total): stored, then refused.
      const bigger = pdfOfSize(4096, "agenda.pdf").buffer;
      const within = await postToStorage(policy, bigger);
      assert.ok(within.status === 204 || within.status === 201 || within.status === 200, `storage refused a body within the policy: ${within.status} ${within.code}`);
      const v = await verdict(page, "agenda.pdf");
      if (!need(t, v)) return;
      assert.equal(v.pill, "Refused", `a body larger than declared became ${v.pill}`);
      const objects = await localObjects(r.out.request_id);
      if (objects) assert.ok(!objects.some((k) => k.endsWith(id)), "the refused body is deleted");
      await dontSend(page);
    } finally {
      await closePage(page);
    }
  });

  test("case F4: content-type spoofing → a Content-Type other than the policy's is refused by storage; PDF bytes declared as PNG, and HTML declared as text, are refused by the content check", async (t) => {
    const page = await pageAs(browser, "a");
    try {
      const r = await awaitingOn(page, a, "Is the attached poster legible?");
      const asPng = await addHeld(page, r, { name: "poster.png", mimeType: "image/png", buffer: F.pdf().buffer });
      const html = Buffer.from("<html><body><script>alert(1)</script></body></html>\n");
      const asText = await addHeld(page, r, { name: "readme.txt", mimeType: "text/plain", buffer: html });
      // The policy fixes Content-Type: another one is refused before anything is stored.
      const swapped = await postToStorage(asPng.policy, F.pdf().buffer, { "Content-Type": "text/html" });
      assert.equal(swapped.status, 403, `a Content-Type outside the policy was stored: ${swapped.status}`);
      assert.equal(swapped.code, "AccessDenied");
      // Declared types honoured by storage, contradicted by the bytes.
      assert.ok((await postToStorage(asPng.policy, F.pdf().buffer)).status < 300);
      assert.ok((await postToStorage(asText.policy, html)).status < 300);
      for (const name of ["poster.png", "readme.txt"]) {
        const v = await verdict(page, name);
        if (!need(t, v)) return;
        assert.equal(v.pill, "Refused", `${name} became ${v.pill}`);
        assert.ok(v.text.includes(COPY.refusedType), v.text);
      }
      await dontSend(page);
    } finally {
      await closePage(page);
    }
  });

  test("case F5: EICAR → refused by the security check through the page and when posted straight to storage; the detection is never named", async (t) => {
    const page = await pageAs(browser, "a");
    try {
      const r = await awaitingOn(page, a, "Is the attached note complete?");
      await addFiles(page, [F.eicar()]);
      // Its upload ends before the browser's uploads are held for the next file.
      const up = await afterUpload(page, "notes.txt");
      if (!need(t, up)) return;
      // Declared as CSV, posted by the test itself: the check does not depend on the browser.
      const bytes = Buffer.from(eicar(), "latin1");
      const direct = await addHeld(page, r, { name: "minutes.csv", mimeType: "text/csv", buffer: bytes });
      assert.ok((await postToStorage(direct.policy, bytes)).status < 300);
      for (const name of ["notes.txt", "minutes.csv"]) {
        const v = name === "notes.txt" ? await afterCheck(page, name) : await verdict(page, name);
        if (!need(t, v)) return;
        assert.equal(v.pill, "Refused", `${name} became ${v.pill}`);
        assert.ok(v.text.includes(COPY.refusedMalware), v.text);
      }
      const text = await mainText(page);
      for (const leak of ["EICAR", "Eicar", "Test-File", "THREATS"]) assert.ok(!text.includes(leak), `the page names the detection (${leak})`);
      assert.equal(await sendButton(page).isDisabled(), true, "Send unavailable with refused files listed");
      const objects = await localObjects(r.out.request_id);
      if (objects) assert.deepEqual(objects, [], "both flagged files deleted");
      await dontSend(page);
    } finally {
      await closePage(page);
    }
  });

  test("case F6: reading a file by guessing its address → unsigned reads refused, a link bent to another file refused, ids unguessable, another account gets nothing", { skip: PAGE_AB }, async (t) => {
    const page = await pageAs(browser, "a");
    const other = await pageAs(browser, "b");
    try {
      const r = await awaitingOn(page, a, "Is the attached map clear?");
      // A stored object in the upload area (no CORS needed: posted from here).
      const held = await addHeld(page, r, F.png());
      assert.match(held.id, FILE_ID_PATTERN, "file ids are 22 random url-safe characters after f (128 bits)");
      assert.ok(!held.policy.fields["key"]!.includes("chart"), "no name in the key");
      assert.ok((await postToStorage(held.policy, F.png().buffer)).status < 300);
      if (ANONYMOUS_ENFORCED) {
        assert.equal(await guessObject(held.policy, held.policy.fields["key"]!), 403, "an unsigned read of the upload area");
        assert.equal(await guessObject(held.policy, held.policy.fields["key"]!.replace(/^tmp\//, "uploads/")), 403, "an unsigned read of the clean area");
        assert.equal(await guessObject(held.policy, ""), 403, "listing the bucket");
      } else {
        t.diagnostic("unsigned reads not checked: LocalStack does not enforce bucket access (they are checked on every deployed stage)");
      }
      // A ready file: its link bent to another id, and B asking for it.
      await addFiles(page, [F.webp()]);
      const o = await afterCheck(page, "diagram.webp");
      if (!need(t, o)) return;
      assert.equal(o.pill, "Ready", o.text);
      const link = await openedLink(page, "diagram.webp");
      assert.equal((await fetchLink(link)).status, 200);
      const u = new URL(link);
      u.pathname = u.pathname.replace(/f[A-Za-z0-9_-]{22}$/, held.id);
      const bent = await fetchLink(u.toString());
      assert.equal(bent.status, 403, `a link bent to another file: ${bent.status}`);
      assert.equal(bent.code, "SignatureDoesNotMatch");
      const unsigned = new URL(link);
      for (const p of [...unsigned.searchParams.keys()]) if (p.startsWith("X-Amz-")) unsigned.searchParams.delete(p);
      if (ANONYMOUS_ENFORCED) assert.equal((await fetchLink(unsigned.toString())).status, 403, "the link without its signature");
      const opened = await captureAction(page, (args) => args.length === 2 && typeof args[1] === "string", () => openedLink(page, "diagram.webp").then(() => undefined));
      assert.equal(await openLink(other, r.out.approval_url), PAGE.wrongPrincipal);
      assert.deepEqual(redact(await replayAction(other, opened.action, opened.args)), { url: null }, "B asking for A's file");
      assert.deepEqual(redact(await replayAction(page, opened.action, [r.out.request_id, "f".padEnd(23, "A")])), { url: null }, "A guessing an id");
      await dontSend(page);
    } finally {
      await closePage(page);
      await closePage(other);
    }
  });

  test("case F7: after Send → add, remove and upload-failed replayed change nothing; re-posting the sent file with its old policy does not change what was sent", async (t) => {
    if (guard) return t.skip(guard);
    const page = await pageAs(browser, "a");
    try {
      const r = await awaitingOn(page, a, "Is the attached table of contents complete?");
      const added = await captureAction(page, addOf("leaflet.pdf"), () => addFiles(page, [F.pdf()]));
      const policy = policyOf(added.result) as UploadPolicy;
      const id = fileIdOf(added.result)!;
      const o = await afterCheck(page, "leaflet.pdf");
      if (!need(t, o)) return;
      assert.equal(o.pill, "Ready", o.text);
      // The remove action's id, from a second file removed before Send.
      await addFiles(page, [F.csv()]);
      await afterCheck(page, "figures.csv");
      const removeCsv = await captureAction(page, (args) => args.length === 2 && typeof args[1] === "string" && args[1] !== id, () => files.remove(page, "figures.csv").click());
      // The upload-failed action's id, from a third file whose upload storage "fails" (answered by the test).
      const failing = async (route: import("@playwright/test").Route) => {
        const req = route.request();
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": origin(r), "access-control-allow-methods": "POST", "access-control-allow-headers": "*" } });
        if (req.method() === "POST") return route.fulfill({ status: 500, headers: { "access-control-allow-origin": origin(r) } });
        return route.fallback();
      };
      const notWeb = (url: URL) => url.origin !== origin(r);
      await page.route(notWeb, failing);
      let brokenId = "";
      const uploadFailed = await captureAction(page, (args) => args.length === 2 && typeof args[1] === "string" && args[1] !== id && (brokenId === "" || args[1] === brokenId), async () => {
        const brokenAdd = await captureAction(page, addOf("broken.txt"), () => addFiles(page, [{ name: "broken.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]));
        brokenId = fileIdOf(brokenAdd.result)!;
      });
      await page.unroute(notWeb, failing);
      assert.equal(uploadFailed.args[1], brokenId, "the page reported the failed upload");
      await files.remove(page, "broken.txt").click();
      await until("the row to go", 15_000, async () => ((await files.row(page, "broken.txt").count()) === 0 ? true : undefined), 300);
      assert.equal((await decide(page, "send")).heading, PAGE.sent);
      const before = await checkOne(a, r.out.request_id);
      assert.equal(before.files.length, 1);

      assert.equal((await replayAction(page, added.action, [r.out.request_id, { name: "late.pdf", type: "application/pdf", size: 100 }]))?.["kind"], "unavailable", "add after Send");
      assert.equal((await replayAction(page, removeCsv.action, [r.out.request_id, id]))?.["kind"], "unavailable", "remove after Send");
      const refusedLate = await replayAction(page, uploadFailed.action, [r.out.request_id, id]);
      t.diagnostic(`upload-failed replayed on the sent file: ${JSON.stringify(refusedLate?.["kind"])}`);
      await page.goto(localLink(r.out.approval_url).replace(/\?.*$/, ""));
      const posted = await postToStorage(policy, Buffer.from("%PDF-1.4\nreplaced\n%%EOF\n"));
      t.diagnostic(`re-post with the old policy: storage answered ${posted.status} (the upload area only; the sent copy is elsewhere)`);
      await new Promise((res) => setTimeout(res, 10_000));
      const after = await checkOne(a, r.out.request_id);
      assert.deepEqual(after.files, before.files, "the files of the sent request changed");
      assert.equal(await heading(page), PAGE.alreadySent);
      const link = await openedLink(page, "leaflet.pdf");
      const got = await fetchLink(link);
      assert.equal(got.status, 200);
      assert.ok(got.body.equals(F.pdf().buffer), "the sent file's bytes changed");
    } finally {
      await closePage(page);
    }
  });

  test("case F8: racing remove and Send → either sent with the file (still readable) or sent without it; never sent with a removed file", async (t) => {
    if (guard) return t.skip(guard);
    for (let round = 1; round <= RACE_ROUNDS; round++) {
      const page = await pageAs(browser, "a");
      try {
        const r = await awaitingOn(page, a, `Is the attached chart honest about its scale? (race ${round})`);
        const added = await captureAction(page, addOf("chart.png"), () => addFiles(page, [F.png(), F.csv()]));
        const pngId = fileIdOf(added.result)!;
        for (const name of ["chart.png", "figures.csv"]) {
          const o = await afterCheck(page, name);
          if (!need(t, o)) return;
          assert.equal(o.pill, "Ready", o.text);
        }
        const removeCsv = await captureAction(page, (args) => args.length === 2 && typeof args[1] === "string", () => files.remove(page, "figures.csv").click());
        await until("the row to go", 15_000, async () => ((await files.row(page, "figures.csv").count()) === 0 ? true : undefined), 300);
        // Send is clicked at once; the remove leaves after a delay that grows each round (0, 150, 300 ms …), so that
        // some rounds see Send first and others the remove first.
        const delay = ((round - 1) % 6) * 150;
        const [removed, sent] = await Promise.all([
          new Promise((res) => setTimeout(res, delay)).then(() => replayAction(page, removeCsv.action, [r.out.request_id, pngId])),
          decide(page, "send"),
        ]);
        const after = await checkOne(a, r.out.request_id);
        const gone = removed?.["kind"] === "removed";
        t.diagnostic(`round ${round} (remove after ${delay} ms): remove → ${String(removed?.["kind"])}, Send → ${sent.heading}, files sent: ${after.files.length}`);
        if (sent.heading === PAGE.sent || after.status !== "awaiting_approval") {
          if (after.files.length === 1) {
            assert.ok(!gone, `round ${round}: the request was sent with a file the remove call reports removed`);
            await openLink(page, r.out.approval_url);
            const got = await fetchLink(await openedLink(page, "chart.png"));
            assert.equal(got.status, 200, `round ${round}: the sent file is not readable (${got.code})`);
          } else {
            assert.equal(after.files.length, 0);
            assert.ok(gone, `round ${round}: sent without the file although it was not removed`);
          }
        } else {
          // Send lost to the remove and was refused (files_not_ready never: the file was ready) → nothing sent.
          assert.ok(gone);
          assert.deepEqual(after.files, []);
        }
      } finally {
        await closePage(page);
      }
    }
  });
});
