// Files on the approval page in a browser (m2-attachments task 5.2), against
// a running stage. Test names are the spec's scenarios (platform/approval-page,
// platform/attachments).
//
// What a stage must offer, and what happens when it does not:
// - Refusals before storing (too large, too many) need nothing but the page.
// - Uploading needs the bucket's CORS for the stage's origin and the web
//   role's write grant (group 3, task 3.1). Without them the upload fails
//   ("The upload did not finish"); the tests that need a stored file are then
//   skipped with that reason, unless A2H_E2E_REQUIRE_FILE_STORAGE=1 (then
//   they fail).
// - Ready and refused-by-the-scan need the worker's check (group 3, task
//   3.2), or locally the stand-in of lib/file-check.ts
//   (A2H_E2E_FILE_CHECK_STANDIN=1). Without either, a file stays "Checking";
//   the tests that need a ready file are skipped with that reason, unless
//   A2H_E2E_REQUIRE_FILE_CHECKS=1 (then they fail).
// Test data: POST /test-fixtures/approval (src/approval/fixture.ts), a paid
// request to sim-mv-7f3c, whose rules accept files up to 50 MB.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "@playwright/test";
import { signIn } from "./lib/browser";
import { EMAIL, WEB_URL } from "./lib/env";
import { STANDIN, startFileCheckStandIn, type StandIn } from "./lib/file-check";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const MB = 1024 * 1024;
const REQUIRE_STORAGE = process.env["A2H_E2E_REQUIRE_FILE_STORAGE"] === "1";
const REQUIRE_CHECKS = process.env["A2H_E2E_REQUIRE_FILE_CHECKS"] === "1" || STANDIN;
/** How long a file may stay "Checking" before the stage is taken to have no check (the scan takes seconds). */
const CHECK_WAIT_MS = STANDIN ? 30_000 : 120_000;

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
/** The standard antivirus test file (harmless; recognised by every scanner). */
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");

test.describe.configure({ mode: "serial" });

let owner: StorageState;
let standIn: StandIn | undefined;
/** Learnt once per run: whether this stage stores uploads and checks them. */
let storage: boolean | undefined;
let checks: boolean | undefined;

interface Fixture {
  request_id: string;
  url: string;
  question: string;
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/sign-in");
  await signIn(page, EMAIL);
  await expect(page).toHaveURL(/\/account\/clients/);
  owner = await ctx.storageState();
  await ctx.close();
  if (STANDIN) standIn = startFileCheckStandIn();
});

test.afterAll(async () => {
  await standIn?.stop();
});

async function as(browser: Browser, options: BrowserContextOptions = {}): Promise<Page> {
  const ctx = await browser.newContext({ storageState: owner, ...options });
  return ctx.newPage();
}

async function fixture(page: Page): Promise<Fixture> {
  const res = await page.request.post(`${WEB_URL}/test-fixtures/approval`, { data: { variant: "paid" } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Fixture;
}

async function openRequest(page: Page): Promise<Fixture> {
  const f = await fixture(page);
  await page.goto(f.url);
  await expect(page).toHaveURL(`${WEB_URL}/approve/${f.request_id}`);
  return f;
}

const send = (page: Page) => page.getByRole("button", { name: /^Send/ });
const choose = (page: Page) => page.getByRole("button", { name: "Choose files" });
const question = (page: Page) => page.getByRole("textbox", { name: "Your question, sent exactly as written" });
const filesList = (page: Page) => page.getByRole("list", { name: "Files they will consult" });
const row = (page: Page, name: string): Locator => page.getByRole("listitem").filter({ hasText: name });
const announcer = (page: Page) => page.locator("section[aria-labelledby='request-files'] [role='status']");

/** Through the system picker, as a person would: click (or Enter on) Choose files. */
async function addFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[], how: "click" | "enter" = "click"): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  if (how === "click") await choose(page).click();
  else await page.keyboard.press("Enter");
  await (await chooser).setFiles(files);
}

/**
 * Waits until the browser's upload of `name` ended. Skips the test when the
 * stage's storage refused it (no CORS or grant yet), unless storage is required.
 */
async function needStorage(page: Page, name: string): Promise<void> {
  if (storage === false && !REQUIRE_STORAGE) test.skip(true, "uploads to storage are not available on this stage (group 3: bucket CORS and the web role's grant)");
  const r = row(page, name);
  await expect(r.getByText(/^(Checking|Ready|Refused)$/)).toBeVisible({ timeout: 60_000 });
  const failed = await r.getByText("The upload did not finish.", { exact: false }).isVisible();
  if (failed) {
    storage = false;
    expect(REQUIRE_STORAGE, "the upload to storage failed and A2H_E2E_REQUIRE_FILE_STORAGE=1").toBe(false);
    test.skip(true, "uploads to storage are not available on this stage (group 3: bucket CORS and the web role's grant)");
  }
  storage = true;
}

/** Waits for the check to finish with `outcome`. Skips when the stage checks nothing (no worker yet), unless checks are required. */
async function needCheck(page: Page, name: string, outcome: "Ready" | "Refused" = "Ready"): Promise<void> {
  test.setTimeout(CHECK_WAIT_MS + 90_000);
  await needStorage(page, name);
  if (checks === false && !REQUIRE_CHECKS) test.skip(true, "files are not checked on this stage (group 3: the worker's file-check and the scanner)");
  const r = row(page, name);
  try {
    await expect(r.getByText(outcome, { exact: true })).toBeVisible({ timeout: CHECK_WAIT_MS });
    checks = true;
  } catch (e) {
    if (REQUIRE_CHECKS || (await r.getByText(/^(Ready|Refused)$/).isVisible())) throw e;
    checks = false;
    test.skip(true, "files are not checked on this stage (group 3: the worker's file-check and the scanner)");
  }
}

async function axe(page: Page, label: string): Promise<void> {
  await expect(page.locator("[data-live-announcer] [role='img']")).toHaveCount(0, { timeout: 10_000 });
  await page.addScriptTag({ content: AXE });
  const violations = await page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: Document, o: unknown) => Promise<{ violations: { id: string; nodes: { target: unknown[] }[] }[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => JSON.stringify(n.target)).join(", ")}`);
  });
  expect.soft(violations, label).toEqual([]);
}

async function smallTargets(page: Page): Promise<string[]> {
  return page.$$eval("main button, main textarea, header button", (els) =>
    els
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .map(({ el, r }) => {
        // Visually hidden (clipped, itself or by an ancestor: React Aria's drop button, keyboard and paste only) is no pointer target.
        let hidden = false;
        for (let n: Element | null = el; n && !hidden; n = n.parentElement) {
          const s = getComputedStyle(n);
          hidden = s.clipPath !== "none" || (s.clip !== "auto" && s.clip !== "");
        }
        return { name: (el.textContent || el.getAttribute("aria-label") || el.tagName).trim(), r, hidden };
      })
      .filter(({ r, hidden }) => !hidden && r.width > 0 && Math.min(r.width, r.height) < 44)
      .map(({ name, r }) => `${name} ${r.width}x${r.height}`),
  );
}

test.describe("Requirement: Only allowed files of bounded size", () => {
  test("Too large: refused before anything is stored, with the limit stated", async ({ browser }) => {
    const page = await as(browser);
    await openRequest(page);
    await addFiles(page, [{ name: "minutes-big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(25 * MB + 1, 0x20) }]);
    const r = row(page, "minutes-big.pdf");
    await expect(r.getByText("Refused", { exact: true })).toBeVisible();
    await expect(r).toContainText("This file is over 25 MB, the most for one file.");
    await expect(announcer(page)).toContainText("minutes-big.pdf refused.");
  });
});

test.describe("Requirement: The principal can attach files before Send", () => {
  test("Refused file blocks Send until removed", async ({ browser }) => {
    const page = await as(browser);
    await openRequest(page);
    await expect(send(page)).toBeEnabled();
    await addFiles(page, [{ name: "minutes-big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(25 * MB + 1, 0x20) }]);
    await expect(row(page, "minutes-big.pdf")).toContainText("This file is over 25 MB");
    await expect(page.getByText("Remove the refused file to send.")).toBeVisible();
    await expect(send(page)).toBeDisabled();
    await axe(page, "a refused file listed");
    await page.getByRole("button", { name: "Remove minutes-big.pdf" }).click();
    await expect(row(page, "minutes-big.pdf")).toHaveCount(0);
    await expect(page.getByText("Remove the refused file to send.")).toHaveCount(0);
    await expect(send(page)).toBeEnabled();
    await expect(announcer(page)).toContainText("minutes-big.pdf removed.");
  });

  test("Refused file blocks Send until removed: refused by the security check (EICAR named notes.txt)", async ({ browser }) => {
    const page = await as(browser);
    await openRequest(page);
    await addFiles(page, [{ name: "notes.txt", mimeType: "text/plain", buffer: EICAR }]);
    await needCheck(page, "notes.txt", "Refused");
    await expect(row(page, "notes.txt")).toContainText("The security check refused this file, so it has been deleted.");
    await expect(page.getByText("Remove the refused file to send.")).toBeVisible();
    await expect(send(page)).toBeDisabled();
    await page.getByRole("button", { name: "Remove notes.txt" }).click();
    await expect(row(page, "notes.txt")).toHaveCount(0);
    await expect(send(page)).toBeEnabled();
  });

  test("Send waits for checking (as far as the stage checks)", async ({ browser }) => {
    const page = await as(browser);
    await openRequest(page);
    await addFiles(page, [{ name: "leaflet.pdf", mimeType: "application/pdf", buffer: PDF }]);
    // Uploading, then checking: Send unavailable with the reason next to it, either way.
    await expect(send(page)).toBeDisabled();
    await expect(page.getByText(/^Files are (uploading|being checked)\. Send will be available when every file is ready\.$/)).toBeVisible();
    await needStorage(page, "leaflet.pdf");
    await needCheck(page, "leaflet.pdf");
    await expect(page.getByText(/Send will be available when every file is ready/)).toHaveCount(0);
    await expect(send(page)).toBeEnabled();
    await expect(announcer(page)).toContainText("Every file is ready. Send is available.");
  });

  test("Add and send", async ({ browser }) => {
    const page = await as(browser);
    const f = await openRequest(page);
    await addFiles(page, [{ name: "leaflet.pdf", mimeType: "application/pdf", buffer: PDF }]);
    await expect(row(page, "leaflet.pdf")).toContainText("PDF ·");
    await needCheck(page, "leaflet.pdf");
    await expect(page.getByRole("definition").filter({ hasText: /^1 file, / })).toBeVisible();
    await send(page).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Question sent");
    const sent = page.getByRole("list", { name: "Files sent with it" });
    await expect(sent.getByRole("listitem")).toHaveCount(1);
    await expect(sent).toContainText("leaflet.pdf");
    await expect(page.getByRole("button", { name: "Open leaflet.pdf" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
    expect(page.url()).toBe(`${WEB_URL}/approve/${f.request_id}`);
  });

  test("Remove a file", async ({ browser }) => {
    const page = await as(browser);
    await openRequest(page);
    await addFiles(page, [
      { name: "chart.png", mimeType: "image/png", buffer: PNG },
      { name: "keep.pdf", mimeType: "application/pdf", buffer: PDF },
    ]);
    await needStorage(page, "chart.png");
    // A ready file when the stage checks files; otherwise the file as it is (checking).
    if (checks !== false) await needCheck(page, "chart.png").catch(() => undefined);
    await page.getByRole("button", { name: "Remove chart.png" }).click();
    await expect(row(page, "chart.png")).toHaveCount(0);
    await expect(filesList(page).getByRole("listitem")).toHaveCount(1);
    await expect(announcer(page)).toContainText("chart.png removed.");
    // Focus moves to the next file's first control, else the previous one's.
    await expect(page.getByRole("button", { name: /keep\.pdf$/ }).first()).toBeFocused();
    // Reloaded, the page lists only what remains.
    await page.reload();
    await expect(filesList(page).getByRole("listitem")).toHaveCount(1);
    await expect(filesList(page)).toContainText("keep.pdf");
  });

  test("Files on a sent request; Principal opens their file (edits to the question survive)", async ({ browser }) => {
    const page = await as(browser);
    const f = await openRequest(page);
    await addFiles(page, [{ name: "chart.png", mimeType: "image/png", buffer: PNG }]);
    await needCheck(page, "chart.png");
    const edited = `${f.question} Edited before opening.`;
    await question(page).fill(edited);
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Open chart.png" }).click();
    const tab = await popup;
    await tab.waitForURL(/X-Amz-Expires=300/);
    expect(new URL(tab.url()).searchParams.get("response-content-disposition")).toBe("inline");
    expect(await tab.evaluate(() => window.opener === null)).toBe(true);
    expect(tab.url()).not.toContain("chart.png");
    await tab.close();
    await expect(question(page)).toHaveValue(edited);
    expect(page.url()).toBe(`${WEB_URL}/approve/${f.request_id}`);
    await send(page).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Question sent");

    // The link of the sent request, opened again.
    await page.goto(`${WEB_URL}/approve/${f.request_id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This question was already sent");
    await expect(page.getByRole("list", { name: "Files sent with it" })).toContainText("chart.png");
    await expect(page.getByRole("button", { name: "Open chart.png" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
    await expect(choose(page)).toHaveCount(0);
    const again = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Open chart.png" }).click();
    const t2 = await again;
    await t2.waitForURL(/X-Amz-Expires=300/);
    await t2.close();
  });

  test("Keyboard and phone: keyboard only", async ({ browser }) => {
    const page = await as(browser);
    await openRequest(page);
    await question(page).focus();
    // Tab to Choose files (question → Restore when edited → files → drop zone → Choose files).
    for (let i = 0; i < 6 && !(await choose(page).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(choose(page)).toBeFocused();
    await addFiles(page, [{ name: "IMG_2041.jpg", mimeType: "image/jpeg", buffer: JPEG }], "enter");
    await expect(row(page, "IMG_2041.jpg")).toBeVisible();
    await expect(announcer(page)).toContainText("Uploading IMG_2041.jpg.");
    // Back to the file's Remove: Shift+Tab past the drop zone's button (and Open, when ready).
    const remove = page.getByRole("button", { name: /^Remov(e|ing) IMG_2041\.jpg$/ });
    for (let i = 0; i < 4 && !(await remove.evaluate((el) => el === document.activeElement).catch(() => false)); i++) await page.keyboard.press("Shift+Tab");
    await expect(remove).toBeFocused();
    await page.keyboard.press("Space");
    await expect(row(page, "IMG_2041.jpg")).toHaveCount(0);
    await expect(announcer(page)).toContainText("IMG_2041.jpg removed.");
    await expect(choose(page)).toBeFocused();
  });

  test("Keyboard and phone: a photo from a phone at 390 px", async ({ browser }) => {
    const page = await as(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await openRequest(page);
    const box = await choose(page).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    // Full width under 600 px.
    expect(box!.width).toBeGreaterThan(300);
    await addFiles(page, [{ name: "IMG_2041.jpg", mimeType: "image/jpeg", buffer: JPEG }]);
    await expect(row(page, "IMG_2041.jpg")).toContainText("JPEG image ·");
    await expect(announcer(page)).toContainText("Uploading IMG_2041.jpg.");
    expect(await smallTargets(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await axe(page, "phone with a file");
    await page.getByRole("button", { name: /^Remove IMG_2041\.jpg$/ }).tap();
    await expect(row(page, "IMG_2041.jpg")).toHaveCount(0);
  });
});
