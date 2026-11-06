// The approval page (spec platform/approval-page, m2-approval-page) on a live
// stage, reached the way a principal reaches it: from the link a real
// `request_human` call returned (A2H_TOKEN), opened in the QA principal's
// signed-in browser (A2H_SESSION_STATE; principal B's for "Wrong
// principal"). One test per scenario, named after it. apps/web's own e2e
// covers the same page through its test fixture route; these prove the
// page with the requests the MCP server records.
//
// Handles: sim-mv-7f3c (paid and free lane), sim-jw-9e48 (poll), never sent;
// sim-ep-5c07 receives the one Send ("Already decided", gross €10.00).
// Needs A2H_WEB_URL, A2H_MCP_URL, A2H_TOKEN, A2H_SESSION_STATE(_2); "Signed
// out" also A2H_TEST_EMAIL and the mail sink. Skipped, with the reason, without them.
import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { bearerToken, expectedStage } from "../src/live-env.ts";
import { manifest, principalClient, requestAwaiting, type Args } from "../contract/a2h.ts";
import { PAGE, pageSkip, QUESTION_LABEL, sessionFile } from "../lib/approval-page.ts";
import { sinkClientFromEnv, waitForMagicLink } from "../lib/mail-sink.ts";

const STAGE = expectedStage();
const EMAIL = process.env["A2H_TEST_EMAIL"]?.trim();
const SINK = process.env["A2H_MAIL_SINK_BUCKET"] || process.env["A2H_MAIL_SINK_DIR"] ? sinkClientFromEnv() : undefined;
const MISSING = (bearerToken() ? false : "needs A2H_TOKEN (tests/lib/obtain-token.ts)") || pageSkip("a");
const PUSH_POLL = "Would you still trust this clinic if you learned its director lied about the results?";
const MV_QUESTION = "Would a newly diagnosed patient find the insulin section of this leaflet alarming?";

/** A real request through request_human; returns its link and id. */
async function link(args: Args): Promise<{ url: string; id: string }> {
  const c = await principalClient();
  try {
    const { out } = await requestAwaiting(c, args);
    return { url: out.approval_url, id: out.request_id };
  } finally {
    await c.close();
  }
}

const paid = () => link(manifest("sim-mv-7f3c", "judgment", 3500, MV_QUESTION));

async function as(browser: Browser, who: "a" | "b" | null, options: BrowserContextOptions = {}): Promise<Page> {
  const state = who ? sessionFile(who) : undefined;
  const ctx = await browser.newContext({ ...options, ...(state ? { storageState: state } : {}) });
  return ctx.newPage();
}

async function open(page: Page, l: { url: string; id: string }): Promise<void> {
  await page.goto(l.url);
  // The token leaves the address bar at once (design D7).
  await expect(page).toHaveURL(`${new URL(l.url).origin}/approve/${l.id}`);
}

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
const question = (page: Page) => page.getByRole("textbox", { name: QUESTION_LABEL });
const send = (page: Page) => page.getByRole("button", { name: /^Send/ });
const dontSend = (page: Page) => page.getByRole("button", { name: "Don't send" });
const restore = (page: Page) => page.getByRole("button", { name: "Restore agent draft" });

test.describe("platform/approval-page from real request_human links", () => {
  test.skip(!!MISSING, MISSING || "");

  test.describe("Requirement: Only the request's principal sees the request", () => {
    test("Scenario: Signed out", async ({ browser }) => {
      test.skip(!EMAIL || !SINK, "needs A2H_TEST_EMAIL and the mail sink");
      test.setTimeout(120_000);
      const l = await paid();
      const page = await as(browser, null);
      const since = new Date(Date.now() - 1_000);
      await page.goto(l.url);
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=${encodeURIComponent(`/approve/${l.id}`)}$`));
      const token = new URL(l.url).searchParams.get("t")!;
      expect(page.url()).not.toContain(token);
      await page.getByLabel("Email address").fill(EMAIL!);
      await page.getByRole("button", { name: "Email me a sign-in link" }).click();
      await expect(page).toHaveURL(/\/sign-in\/sent/);
      const magic = await waitForMagicLink(SINK!.client, STAGE, EMAIL!, since, { timeoutMs: 45_000 });
      expect(magic).not.toContain(token);
      await page.goto(magic);
      await expect(page).toHaveURL(`${new URL(l.url).origin}/approve/${l.id}`);
      await expect(h1(page)).toHaveText(PAGE.awaiting);
      await expect(question(page)).toHaveValue(MV_QUESTION);
    });

    test("Scenario: Wrong principal", async ({ browser }) => {
      test.skip(!!pageSkip("b"), pageSkip("b") || "");
      const l = await paid();
      const page = await as(browser, "b");
      await open(page, l);
      await expect(h1(page)).toHaveText(PAGE.wrongPrincipal);
      for (const leak of [l.id, "Margaret", "€", MV_QUESTION]) await expect(page.locator("main")).not.toContainText(leak);
      await expect(page.getByRole("button", { name: /^Send|Don't send/ })).toHaveCount(0);
      await expect(question(page)).toHaveCount(0);
    });
  });

  test.describe("Requirement: The page shows what the participant will receive", () => {
    test("Scenario: Poll request", async ({ browser }) => {
      const options = [
        { id: "a", label: "Route A along the harbourside" },
        { id: "b", label: "Route B through Stokes Croft — «quiet»" },
        { id: "c", label: "Route C & the canal path" },
      ];
      const l = await link(manifest("sim-jw-9e48", "opinion", 800, "Which of these routes into central Bristol feels safest to cycle?", { format: "poll", options, scale: { min: 1, max: 5 } }));
      const page = await as(browser, "a");
      await open(page, l);
      await expect(page.getByRole("list").filter({ hasText: options[0]!.label }).getByRole("listitem")).toHaveText(options.map((o) => o.label));
      await expect(page.getByText("They answer on a scale from 1 to 5.")).toBeVisible();
    });

    test("Scenario: Simulated participant", async ({ browser }) => {
      const page = await as(browser, "a");
      await open(page, await paid());
      await expect(page.getByText("Margaret Vale (simulated)").first()).toBeVisible();
      // Owner decision 2026-11-05 (m2-approval-page design.md A1, "To" row).
      await expect(page.getByText("Test participant. No one real will be asked.")).toBeVisible();
    });

    test("Scenario: Time zone", async ({ browser }) => {
      const page = await as(browser, "a", { timezoneId: "Asia/Kolkata" });
      await open(page, await paid());
      const expires = page.locator("dd time").first();
      await expect(expires).toContainText("(UTC+05:30)");
      const iso = await expires.getAttribute("datetime");
      expect(iso).toBeTruthy();
      const ist = new Date(Date.parse(iso!) + 5.5 * 3_600_000);
      await expect(expires).toContainText(`${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`);
    });
  });

  test.describe("Requirement: The question is editable in place", () => {
    test("Scenario: Restore agent draft", async ({ browser }) => {
      const page = await as(browser, "a");
      await open(page, await paid());
      await expect(restore(page)).toHaveCount(0);
      await question(page).fill(`${MV_QUESTION} Edited (é, 中文).`);
      await expect(restore(page)).toBeVisible();
      await restore(page).click();
      await expect(question(page)).toHaveValue(MV_QUESTION);
      await expect(restore(page)).toHaveCount(0);
    });

    test("Scenario: Over the limit", async ({ browser }) => {
      const page = await as(browser, "a");
      await open(page, await paid());
      await question(page).fill("x".repeat(2043));
      await expect(page.getByText("2043 / 2000", { exact: true })).toBeVisible();
      await expect(page.getByText("· 43 over the limit")).toBeVisible();
      await expect(send(page)).toBeDisabled();
      await expect(dontSend(page)).toBeEnabled();
      await question(page).fill("x".repeat(2000));
      await expect(send(page)).toBeEnabled();
    });
  });

  test.describe("Requirement: Two actions, money on the send action", () => {
    test("Scenario: Labels (paid €35.00, and a free lane)", async ({ browser }) => {
      const page = await as(browser, "a");
      await open(page, await paid());
      await expect(send(page)).toHaveText("Send · hold €35.00");
      await expect(dontSend(page)).toHaveText("Don't send");
      await expect(send(page)).not.toBeFocused();
      await expect(dontSend(page)).not.toBeFocused();
      // sim-mv-7f3c declares the own_publications free lane: no money on the send action.
      const free = await link(manifest("sim-mv-7f3c", "judgment", 0, "Is the insulin section of your own leaflet still accurate?", { lane: "free", free_lane: "own_publications" }));
      await open(page, free);
      await expect(send(page)).toHaveText("Send");
    });

    test("Scenario: Enter in the question", async ({ browser }) => {
      const page = await as(browser, "a");
      const l = await paid();
      await open(page, l);
      await question(page).click();
      await question(page).press("End");
      await question(page).press("Enter");
      await question(page).press("Control+Enter");
      await question(page).pressSequentially("Next line");
      await expect(question(page)).toHaveValue(`${MV_QUESTION}\nNext line`);
      await expect(h1(page)).toHaveText(PAGE.awaiting);
      await page.reload();
      await expect(send(page)).toBeVisible();
    });
  });

  test.describe("Requirement: Every state of the page is stated", () => {
    test("Scenario: Already decided", async ({ browser }) => {
      const l = await link(manifest("sim-ep-5c07", "opinion", 1000, "Which of these two covers would make you pick this picture book up first?", { format: "poll", options: [{ id: "fox", label: "The fox in the snow" }, { id: "lighthouse", label: "The lighthouse at night" }] }));
      const page = await as(browser, "a");
      await open(page, l);
      await send(page).click();
      await expect(h1(page)).toHaveText(PAGE.sent);
      await open(page, l);
      await expect(h1(page)).toHaveText(PAGE.alreadySent);
      await expect(page.getByText(/^Sent to .+ at /)).toBeVisible();
      await expect(page.getByText("Your agent can follow it: ask it to check on this request.", { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Send|Don't send/ })).toHaveCount(0);
    });

    test("Scenario: Validation failed after an edit", async ({ browser }) => {
      const page = await as(browser, "a");
      await open(page, await paid());
      await question(page).fill(PUSH_POLL);
      await send(page).click();
      const alert = page.getByRole("main").getByRole("alert");
      await expect(alert).toContainText("This wording can't be sent");
      await expect(question(page)).toHaveValue(PUSH_POLL);
      await expect(send(page)).toBeEnabled();
      await expect(dontSend(page)).toBeEnabled();
    });
  });

  test.describe("Requirement: The page is accessible", () => {
    test("Scenario: Keyboard only", async ({ browser }) => {
      const page = await as(browser, "a");
      await open(page, await paid());
      await page.locator("body").focus();
      const stops: string[] = [];
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Tab");
        stops.push(await page.evaluate(() => (document.activeElement?.tagName === "TEXTAREA" ? "TEXTAREA" : (document.activeElement?.textContent ?? "").trim())));
        expect.soft(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), stops.at(-1)).not.toBe("none");
      }
      expect(stops).toEqual(["Sign out", "TEXTAREA", "Send · hold €35.00", "Don't send"]);
      await question(page).focus();
      await page.keyboard.type(" Edited");
      await page.keyboard.press("Tab");
      await expect(restore(page)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(question(page)).toHaveValue(MV_QUESTION);
      await page.keyboard.press("Tab");
      await expect(send(page)).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dontSend(page)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(h1(page)).toHaveText(PAGE.notSent);
    });

    test("Scenario: Narrow screen", async ({ browser }) => {
      const page = await as(browser, "a", { viewport: { width: 320, height: 640 }, reducedMotion: "reduce" });
      await open(page, await paid());
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      for (const b of [send(page), dontSend(page)]) {
        await b.scrollIntoViewIfNeeded();
        const box = (await b.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    });
  });
});
