// The approval page in a browser (m2-approval-page tasks 5.1-5.4), against a
// running stage: a local server or a preview. Test names are the spec's
// scenarios (platform/approval-page, protocol/request-approval).
//
// Test data: POST /test-fixtures/approval (non-production stages only,
// src/approval/fixture.ts) records an awaiting request for the signed-in
// principal to a simulated participant and returns its link; once
// `request_human` returns the link (group 3) the flows can take it from there.
// Needs what playwright.config.ts lists: A2H_WEB_URL, the mail sink,
// A2H_TEST_EMAIL and A2H_TEST_EMAIL_2 (two allow-listed addresses).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { signIn } from "./lib/browser";
import { newestLink } from "./lib/sink";
import { EMAIL, EMAIL_2, WEB_URL } from "./lib/env";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const PUSH_POLL = "Would you still trust this clinic if you learned its director lied about the results?";
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

test.describe.configure({ mode: "serial" });

let owner: StorageState;
let second: StorageState;

async function signedIn(browser: Browser, email: string): Promise<StorageState> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/sign-in");
  await signIn(page, email);
  await expect(page).toHaveURL(/\/account\/clients/);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function as(browser: Browser, state: StorageState, options: BrowserContextOptions = {}): Promise<Page> {
  const ctx = await browser.newContext({ storageState: state, ...options });
  return ctx.newPage();
}

interface Fixture {
  request_id: string;
  url: string;
  question: string;
}

async function fixture(page: Page, variant: "paid" | "poll" | "expired" | "ending" = "paid"): Promise<Fixture> {
  const res = await page.request.post(`${WEB_URL}/test-fixtures/approval`, { data: { variant } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Fixture;
}

/** Opens the link; the token leaves the address bar at once. */
async function open(page: Page, f: Fixture): Promise<void> {
  await page.goto(f.url);
  await expect(page).toHaveURL(`${WEB_URL}/approve/${f.request_id}`);
}

const question = (page: Page) => page.getByRole("textbox", { name: "Your question, sent exactly as written" });
const send = (page: Page) => page.getByRole("button", { name: /^Send/ });
const dontSend = (page: Page) => page.getByRole("button", { name: "Don't send" });
const restore = (page: Page) => page.getByRole("button", { name: "Restore agent draft" });

async function axe(page: Page, label: string): Promise<void> {
  // react-aria announces a pending Button through its live announcer ([data-live-announcer]):
  // `role="img"` nodes labelled by the button's label id. Once the outcome replaces the form,
  // that id is gone until react-aria clears the announcement (about 7 s); the text was already
  // spoken. axe checks the settled page: wait for the announcer to empty, never exclude it.
  await expect(page.locator("[data-live-announcer] [role='img']")).toHaveCount(0, { timeout: 10_000 });
  await page.addScriptTag({ content: AXE });
  const violations = await page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: Document, o: unknown) => Promise<{ violations: { id: string; nodes: { target: unknown[] }[] }[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
    // Rule id and the selectors of its nodes (no text content: a failure message never carries the question).
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => JSON.stringify(n.target)).join(", ")}`);
  });
  expect.soft(violations, label).toEqual([]);
}

async function smallTargets(page: Page): Promise<string[]> {
  return page.$$eval("main button, main textarea, header button", (els) =>
    els
      .map((el) => {
        // Visually hidden (clipped, itself or by an ancestor: React Aria's drop button of the files section,
        // keyboard and paste only) is no pointer target.
        let hidden = false;
        for (let n: Element | null = el; n && !hidden; n = n.parentElement) {
          const s = getComputedStyle(n);
          hidden = s.clipPath !== "none" || (s.clip !== "auto" && s.clip !== "");
        }
        return { el, r: el.getBoundingClientRect(), hidden };
      })
      .filter(({ r, hidden }) => !hidden && r.width > 0 && Math.min(r.width, r.height) < 44)
      .map(({ el, r }) => `${(el.textContent || el.tagName).trim()} ${r.width}x${r.height}`),
  );
}

test.beforeAll(async ({ browser }) => {
  owner = await signedIn(browser, EMAIL);
  second = await signedIn(browser, EMAIL_2);
});

test.describe("Requirement: Only the request's principal sees the request", () => {
  test("Signed out", async ({ browser }) => {
    const f = await fixture(await as(browser, owner));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const since = new Date(Date.now() - 1_000);
    await page.goto(f.url);
    // To sign-in with the bare page as `next`: the token is in no URL from here on.
    await expect(page).toHaveURL(`${WEB_URL}/sign-in?next=${encodeURIComponent(`/approve/${f.request_id}`)}`);
    await expect(page.getByText("Sign in to review the question your agent wants to send.")).toBeVisible();
    await page.getByLabel("Email address").fill(EMAIL);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page).toHaveURL(/\/sign-in\/sent/);
    expect(page.url()).not.toContain(f.url.split("?t=")[1]!);
    const link = await newestLink(EMAIL, since);
    expect(link).not.toContain(f.url.split("?t=")[1]!);
    await page.goto(link);
    await expect(page).toHaveURL(`${WEB_URL}/approve/${f.request_id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review this question before it is sent");
    await expect(question(page)).toHaveValue(f.question);
    await ctx.close();
  });

  test("Wrong principal", async ({ browser }) => {
    const f = await fixture(await as(browser, owner));
    const page = await as(browser, second);
    await open(page, f);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link belongs to another account");
    await expect(page.getByRole("main").getByText(EMAIL_2)).toBeVisible();
    for (const leak of [f.request_id, "Margaret", "€", f.question]) await expect(page.locator("main")).not.toContainText(leak);
    await expect(page.getByRole("button", { name: /^Send|Don't send/ })).toHaveCount(0);
    await expect(page).toHaveTitle("Another account · A2H");
  });
});

test.describe("Requirement: The page shows what the participant will receive", () => {
  test("Labels", async ({ browser }) => {
    const page = await as(browser, owner);
    await open(page, await fixture(page));
    await expect(send(page)).toHaveText("Send · hold €35.00");
    await expect(dontSend(page)).toHaveText("Don't send");
    await expect(send(page)).not.toBeFocused();
    await expect(dontSend(page)).not.toBeFocused();
  });

  test("Simulated participant", async ({ browser }) => {
    const page = await as(browser, owner);
    await open(page, await fixture(page));
    await expect(page.getByText("Margaret Vale (simulated)").first()).toBeVisible();
    await expect(page.getByText("Test participant. No one real will be asked.")).toBeVisible();
  });

  test("Link validity line only in the link's last hour (owner decision 2026-11-05)", async ({ browser }) => {
    const page = await as(browser, owner);
    const note = () => page.locator("main form p").filter({ hasText: "Nothing is sent and nothing is held until you choose." });
    await open(page, await fixture(page));
    await expect(note()).toBeVisible();
    await expect(note()).not.toContainText("This link works until");
    await open(page, await fixture(page, "ending"));
    await expect(note()).toContainText(/This link works until \d\d:\d\d on \d{1,2} \w{3} \d{4} \(UTC[^)]*\)\./);
  });

  test("Poll request", async ({ browser }) => {
    const page = await as(browser, owner);
    await open(page, await fixture(page, "poll"));
    await expect(page.getByRole("list").filter({ hasText: "The fox in the snow" }).getByRole("listitem")).toHaveText([
      "The fox in the snow",
      "The lighthouse at night — «blue»",
      "The two hens & the umbrella",
    ]);
    await expect(page.getByText("They answer on a scale from 1 to 5.")).toBeVisible();
  });

  test("Time zone", async ({ browser }) => {
    const page = await as(browser, owner, { timezoneId: "Asia/Kolkata" });
    await open(page, await fixture(page));
    const expires = page.locator("dd time").first();
    await expect(expires).toContainText("(UTC+05:30)");
    const iso = await expires.getAttribute("datetime");
    expect(iso).toBeTruthy();
    const ist = new Date(Date.parse(iso!) + 5.5 * 3_600_000);
    await expect(expires).toContainText(`${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")} on ${ist.getUTCDate()}`);
  });
});

test.describe("Requirement: The question is editable in place", () => {
  test("Restore agent draft", async ({ browser }) => {
    const page = await as(browser, owner);
    const f = await fixture(page);
    await open(page, f);
    await expect(restore(page)).toHaveCount(0);
    await question(page).fill(`${f.question} Edited.`);
    await expect(restore(page)).toBeVisible();
    await restore(page).click();
    await expect(question(page)).toHaveValue(f.question);
    await expect(restore(page)).toHaveCount(0);
    await expect(question(page)).toBeFocused();
    await expect(page.getByText("Agent draft restored.")).toBeAttached();
  });

  test("Over the limit", async ({ browser }) => {
    const page = await as(browser, owner);
    await open(page, await fixture(page));
    await question(page).fill("x".repeat(2043));
    // The count is "2043 / 2000" then "· 43 over the limit" (separate spans, an accessible "2043 of 2000 characters" between).
    await expect(page.getByText("2043 / 2000", { exact: true })).toBeVisible();
    await expect(page.getByText("· 43 over the limit")).toBeVisible();
    await expect(page.getByText("Shorten the question by 43 characters to send it.")).toBeVisible();
    await expect(send(page)).toBeDisabled();
    await expect(dontSend(page)).toBeEnabled();
    await question(page).fill("x".repeat(2000));
    await expect(send(page)).toBeEnabled();
  });
});

test.describe("Requirement: Two actions, money on the send action", () => {
  test("Enter in the question", async ({ browser }) => {
    const page = await as(browser, owner);
    const f = await fixture(page);
    await open(page, f);
    await question(page).click();
    await question(page).press("End");
    await question(page).press("Enter");
    await question(page).press("Control+Enter");
    await question(page).press("Meta+Enter");
    await question(page).type("Next line");
    // Enter is the native line break; Ctrl+Enter and Meta+Enter do nothing (design.md, decision bar: no key handler).
    await expect(question(page)).toHaveValue(`${f.question}\nNext line`);
    await expect(page).toHaveURL(`${WEB_URL}/approve/${f.request_id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review this question before it is sent");
    // Nothing was decided: opening it again still awaits a decision.
    await page.reload();
    await expect(send(page)).toBeVisible();
  });
});

test.describe("Requirement: Approval happens on the hosted approval page", () => {
  // Sends use the €10.00 poll (fixture "poll"): a preview's monthly budget and the
  // simulated participants' daily limits must last for many runs.
  test("Send on the page", async ({ browser }) => {
    const page = await as(browser, owner);
    const f = await fixture(page, "poll");
    await open(page, f);
    await expect(send(page)).toHaveText("Send · hold €10.00");
    await send(page).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Question sent");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByText("€10.00 is held.", { exact: false })).toBeVisible();
    await expect(page).toHaveTitle("Question sent · A2H");
    await expect(page.locator("main")).toContainText(f.question);
  });

  test("Don't send on the page", async ({ browser }) => {
    const page = await as(browser, owner);
    await open(page, await fixture(page));
    await dontSend(page).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not sent");
    await expect(page.getByText("Margaret Vale (simulated) was not contacted")).toBeVisible();
    await expect(page).toHaveTitle("Not sent · A2H");
  });

  test("Link expires unused", async ({ browser }) => {
    const page = await as(browser, owner);
    const f = await fixture(page, "expired");
    await open(page, f);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This approval link has expired");
    await expect(page.locator("main")).not.toContainText(f.request_id);
  });
});

test.describe("Requirement: Approval covers the validated manifest", () => {
  test("Accept after editing", async ({ browser }) => {
    const page = await as(browser, owner);
    const f = await fixture(page, "poll");
    await open(page, f);
    const edited = "Which cover would you pick up first? (é, «quotes», 中文)\nSecond line.";
    await question(page).fill(edited);
    await send(page).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Question sent");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This question was already sent");
    expect(await page.locator("main p").filter({ hasText: "Second line." }).innerText()).toBe(edited);
  });

  test("Edit turns the question into a push-poll", async ({ browser }) => {
    const page = await as(browser, owner);
    await open(page, await fixture(page));
    await question(page).fill(PUSH_POLL);
    await send(page).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("This wording can't be sent");
    await expect(alert).toContainText("Nothing was sent and nothing is held.");
    await expect(question(page)).toHaveValue(PUSH_POLL);
    await expect(send(page)).toBeEnabled();
    await expect(dontSend(page)).toBeEnabled();
  });
});

test.describe("Requirement: The link is single-use and bound to its principal", () => {
  test("Decision replayed", async ({ browser }) => {
    const first = await as(browser, owner);
    const f = await fixture(first, "poll");
    await open(first, f);
    const other = await first.context().newPage();
    await open(other, f);
    await send(first).click();
    await expect(first.getByRole("heading", { level: 1 })).toHaveText("Question sent");
    await send(other).click();
    await expect(other.getByRole("heading", { level: 1 })).toHaveText("This question was already sent");
    await expect(other.getByText("Nothing more can be decided on this page.")).toBeVisible();
  });

  test("Forged token", async ({ browser }) => {
    const page = await as(browser, owner);
    const f = await fixture(page);
    await page.goto(`${WEB_URL}/approve/${f.request_id}?t=${"A".repeat(43)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This approval link has expired");
    const known = await page.locator("main").innerHTML();
    await page.goto(`${WEB_URL}/approve/A2H-0000?t=${"A".repeat(43)}`);
    expect(await page.locator("main").innerHTML()).toBe(known);
  });

  test("Another principal opens the link", async ({ browser }) => {
    const mine = await as(browser, owner);
    const f = await fixture(mine);
    const theirs = await as(browser, second);
    await open(theirs, f);
    await expect(theirs.getByRole("heading", { level: 1 })).toHaveText("This link belongs to another account");
    await open(mine, f);
    await expect(send(mine)).toBeVisible();
  });
});

test.describe("Requirement: The page is accessible", () => {
  test("Keyboard only", async ({ browser }) => {
    const page = await as(browser, owner);
    const f = await fixture(page);
    await open(page, f);
    const order = async () => page.evaluate(() => (document.activeElement?.textContent || document.activeElement?.tagName || "").trim());
    await page.locator("body").focus();
    const stops: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      stops.push(await order());
      const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
      expect.soft(outline, stops.at(-1)).not.toBe("none");
    }
    // m2-attachments design.md "Keyboard order and focus": the files section between the question and Send: React Aria's
    // drop button (no text of its own: "BUTTON", named "Drop or paste files here" by its zone), then Choose files.
    expect(stops).toEqual(["Sign out", "TEXTAREA", "BUTTON", "Choose files", "Send · hold €35.00", "Don't send"].map((s) => (s === "TEXTAREA" ? f.question : s)));
    // Edited: Restore comes between the field and the files section.
    await question(page).focus();
    await page.keyboard.type(" Edited");
    await page.keyboard.press("Tab");
    await expect(restore(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(question(page)).toBeFocused();
    await expect(question(page)).toHaveValue(f.question);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Choose files" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(send(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dontSend(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not sent");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  });

  test("Narrow screen", async ({ browser }) => {
    const page = await as(browser, owner, { viewport: { width: 320, height: 640 }, reducedMotion: "reduce" });
    await open(page, await fixture(page, "poll"));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const b of [send(page), dontSend(page)]) {
      await b.scrollIntoViewIfNeeded();
      const box = (await b.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const animated = await page.evaluate(() => [...document.querySelectorAll("*")].filter((el) => getComputedStyle(el).animationName !== "none").length);
    expect(animated).toBe(0);
  });

  for (const width of [320, 390, 1280]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`axe, 44 px targets and no overflow at ${width} px, ${scheme}: awaiting, edited, refused, sent, expired, another account`, async ({ browser }) => {
        const options = { viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" } as const;
        const page = await as(browser, owner, options);
        const check = async (label: string) => {
          await axe(page, `${label} ${width} ${scheme}`);
          expect.soft(await smallTargets(page), `${label} ${width} ${scheme}`).toEqual([]);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect.soft(overflow, `${label} overflow`).toBeLessThanOrEqual(0);
        };
        const f = await fixture(page, "poll");
        await open(page, f);
        await check("awaiting");
        await question(page).fill(`${f.question} Edited.`);
        await check("edited");
        await question(page).fill(PUSH_POLL);
        await send(page).click();
        // The refusal itself, not any alert: the error state is an alert too (pr-82 run 41662927651).
        await expect(page.getByRole("main").getByRole("alert")).toContainText("This wording can't be sent");
        await check("refused");
        if (scheme === "light") {
          // One Send per width (budget and daily limits, see "Send on the page").
          await question(page).fill(f.question);
          await send(page).click();
          await expect(page.getByRole("heading", { level: 1 })).toHaveText("Question sent");
          await check("sent");
        }
        await open(page, await fixture(page, "expired"));
        await check("expired");
        const theirs = await as(browser, second, options);
        await open(theirs, await fixture(page));
        await axe(theirs, `another account ${width} ${scheme}`);
      });
    }
  }

  test("test data is refused signed out", async ({ request }) => {
    const res = await request.post(`${WEB_URL}/test-fixtures/approval`, { data: {} });
    expect(res.status()).toBe(401);
  });
});
