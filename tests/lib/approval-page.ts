// The hosted approval page (m2-approval-page, /approve/[id] in apps/web)
// driven from the node:test suites, as the QA principals: the contract and
// adversarial suites take the link `request_human` returned and choose Send
// or Don't send on the page, the only place a request leaves
// `awaiting_approval` for `sent`.
//
// Sessions: the browser sessions tests/lib/obtain-token.ts signed in
// (A2H_SESSION_STATE for principal A, A2H_SESSION_STATE_2 for B; files 0600,
// never printed). Without them the page cases are skipped with the reason.
// Nothing here prints a link's token, a cookie or the question: failures
// name the request id, the page's path and its headings.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

export type Who = "a" | "b";

/** The page's headings (packages/ui copy.approval), the outcome the suites read. */
export const PAGE = {
  awaiting: "Review this question before it is sent",
  sent: "Question sent",
  notSent: "Not sent",
  alreadySent: "This question was already sent",
  alreadyNotSent: "This request was not sent",
  expired: "This approval link has expired",
  wrongPrincipal: "This link belongs to another account",
} as const;

/** The QUESTION field's accessible name. */
export const QUESTION_LABEL = "Your question, sent exactly as written";

export function sessionFile(who: Who): string | undefined {
  const path = process.env[who === "a" ? "A2H_SESSION_STATE" : "A2H_SESSION_STATE_2"]?.trim();
  return path && existsSync(path) ? path : undefined;
}

/** A skip reason when the signed-in sessions the page needs are missing; false when they are there. */
export function pageSkip(...who: Who[]): string | false {
  const missing = who.filter((w) => !sessionFile(w));
  if (missing.length === 0) return false;
  return `needs the signed-in browser session of principal ${missing.map((w) => w.toUpperCase()).join(" and ")} (A2H_SESSION_STATE${missing.includes("b") ? ", A2H_SESSION_STATE_2" : ""}; tests/lib/obtain-token.ts writes them)`;
}

export async function launch(): Promise<Browser> {
  return chromium.launch();
}

/** A page in a fresh context signed in as `who` (or signed out with `who` null). */
export async function pageAs(browser: Browser, who: Who | null, options: BrowserContextOptions = {}): Promise<Page> {
  const state = who === null ? undefined : sessionFile(who);
  if (who !== null) assert.ok(state, pageSkip(who) || "no session");
  const context = await browser.newContext({ ...options, ...(state ? { storageState: state } : {}) });
  return context.newPage();
}

/** `https://<web>/approve/<id>` without the token. */
export function barePath(link: string): string {
  const u = new URL(link);
  return `${u.origin}${u.pathname}`;
}

export function requestIdOf(link: string): string {
  return new URL(link).pathname.split("/").at(-1)!;
}

export function tokenOf(link: string): string {
  return new URL(link).searchParams.get("t") ?? "";
}

export const questionBox = (page: Page) => page.getByRole("textbox", { name: QUESTION_LABEL });
export const sendButton = (page: Page) => page.getByRole("button", { name: /^Send/ });
export const dontSendButton = (page: Page) => page.getByRole("button", { name: "Don't send" });

export async function heading(page: Page): Promise<string> {
  return ((await page.getByRole("heading", { level: 1 }).first().textContent({ timeout: 30_000 })) ?? "").trim();
}

/** The main region's alerts (a refusal or the error state), trimmed; never asserted with the question in a message. */
export async function alerts(page: Page): Promise<string[]> {
  return (await page.getByRole("main").getByRole("alert").allTextContents()).map((t) => t.trim()).filter(Boolean);
}

/**
 * Opens an approval link: the first hit moves the token into the page's
 * HttpOnly cookie and continues at the bare path (design D7), so the token
 * is never in the address bar after this. Returns the page's heading.
 */
export async function openLink(page: Page, link: string): Promise<string> {
  await page.goto(link, { waitUntil: "load", timeout: 30_000 });
  const at = page.url();
  assert.ok(!at.includes("?t=") && !at.includes("&t="), `the token is still in the address bar of ${requestIdOf(link)}`);
  return heading(page);
}

export interface Decided {
  heading: string;
  alerts: string[];
}

/**
 * Chooses Send (optionally after replacing the question) or Don't send, and
 * waits for the page to settle: a new heading (sent, not sent, already
 * decided, expired, another account) or an alert under the unchanged one
 * (validation refused the edit, or the error state).
 */
export async function decide(page: Page, decision: "send" | "dont_send", o: { question?: string } = {}): Promise<Decided> {
  if (o.question !== undefined) await questionBox(page).fill(o.question);
  const button = decision === "send" ? sendButton(page) : dontSendButton(page);
  await button.click({ timeout: 30_000 });
  await page.waitForFunction(
    (awaiting) => {
      const h = document.querySelector("h1")?.textContent?.trim();
      const alert = [...document.querySelectorAll("main [role=alert]")].some((a) => (a.textContent ?? "").trim() !== "");
      const pending = [...document.querySelectorAll("button")].some((b) => /Sending…|Cancelling…/.test(b.textContent ?? ""));
      return !pending && ((h !== undefined && h !== awaiting) || alert);
    },
    PAGE.awaiting,
    { timeout: 45_000 },
  );
  return { heading: await heading(page), alerts: await alerts(page) };
}

/** Everything the page shows in its main region (for "shows nothing about the request"). */
export async function mainText(page: Page): Promise<string> {
  return (await page.locator("main").innerText({ timeout: 30_000 })).trim();
}

export async function closePage(page: Page): Promise<void> {
  await page.context().close().catch(() => undefined);
}
