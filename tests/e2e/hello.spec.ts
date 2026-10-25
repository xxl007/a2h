// The M0 hello-world page on a live stage: proposal.md "How the product owner
// validates", step 2 ("Click the preview URL: the web page renders").
// Contract (PM 2026-10-25): one server-rendered page with an <h1> "A2H", the
// stage name and the MCP URL. Needs A2H_WEB_URL and A2H_MCP_URL (stage from
// the MCP path, or A2H_STAGE).
import { expect, test, type Page } from "@playwright/test";
import { expectedStage, mcpUrl } from "../src/live-env.ts";

const MCP_URL = mcpUrl();
const STAGE = expectedStage(MCP_URL);
const MAX_TRANSFER_BYTES = 100 * 1024;

/** Loads the page and fails unless it answered 200, so no check passes on an error page. */
async function open(page: Page, waitUntil: "load" | "networkidle" = "load"): Promise<void> {
  const response = await page.goto("/", { waitUntil });
  expect(response?.status(), "status of the page").toBe(200);
}

test("renders the A2H heading", async ({ page }) => {
  await open(page);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText("A2H");
});

test("is server-rendered: heading, stage and MCP URL are in the HTML before any script runs", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/<h1[^>]*>\s*A2H\s*<\/h1>/);
  expect(html).toContain(STAGE);
  expect(html).toContain(MCP_URL.href.replace(/\/$/, ""));
});

test("shows the stage name", async ({ page }) => {
  await open(page);
  await expect(page.getByText(STAGE, { exact: false }).first()).toBeVisible();
});

test("shows the MCP endpoint URL", async ({ page }) => {
  await open(page);
  // new URL() lowercases the host; the page may print it as the deploy output has it.
  const shown = new RegExp(MCP_URL.href.replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  await expect(page.getByText(shown).first()).toBeVisible();
});

test("logs no console errors and throws no page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  await open(page, "networkidle");
  expect(errors).toEqual([]);
});

test(`transfers under ${MAX_TRANSFER_BYTES / 1024} KB in total`, async ({ page }) => {
  // Bytes on the wire (headers + compressed body) for every request of the
  // load, from Chromium's network domain: what a phone on a slow link pays.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const sizes = new Map<string, number>();
  cdp.on("Network.loadingFinished", (event) => sizes.set(event.requestId, event.encodedDataLength));
  await open(page, "networkidle");
  const total = [...sizes.values()].reduce((sum, n) => sum + n, 0);
  test.info().annotations.push({ type: "transfer", description: `${total} bytes in ${sizes.size} requests` });
  expect(sizes.size, "no request was observed").toBeGreaterThan(0);
  expect(total).toBeLessThan(MAX_TRANSFER_BYTES);
});

async function tabbables(page: Page): Promise<string[]> {
  // Elements reachable by Tab, in document order, described the same way the
  // focus walk below describes document.activeElement.
  return page.evaluate(() => {
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex], [contenteditable="true"]';
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
      .map((el) => `${el.tagName.toLowerCase()}|${(el.textContent ?? "").trim().slice(0, 40)}|${el.getAttribute("href") ?? ""}`);
  });
}

test("keyboard focus order follows the document and never traps", async ({ page }) => {
  await open(page);
  const positive = await page.locator("[tabindex]").evaluateAll((els) =>
    els.filter((el) => Number(el.getAttribute("tabindex")) > 0).map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(positive, "positive tabindex reorders focus").toEqual([]);

  const expected = await tabbables(page);
  const visited: string[] = [];
  for (let i = 0; i < expected.length; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const box = el.getBoundingClientRect();
      return {
        id: `${el.tagName.toLowerCase()}|${(el.textContent ?? "").trim().slice(0, 40)}|${el.getAttribute("href") ?? ""}`,
        visible: box.width > 0 && box.height > 0,
      };
    });
    expect(focused, `Tab ${i + 1} focused nothing`).not.toBeNull();
    expect(focused?.visible, `Tab ${i + 1} focused an invisible element`).toBe(true);
    visited.push(focused?.id ?? "");
  }
  expect(visited, "Tab order differs from document order").toEqual(expected);

  // One more Tab leaves the last element (to the browser chrome or back to
  // the start): focus is not trapped on it.
  if (expected.length > 0) {
    await page.keyboard.press("Tab");
    const after = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()}|${(el.textContent ?? "").trim().slice(0, 40)}|${el.getAttribute("href") ?? ""}` : null;
    });
    if (expected.length > 1) expect(after).not.toBe(expected[expected.length - 1]);
  }
});
