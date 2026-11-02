// Browser steps shared by the flows: sign in through the sign-in page and the
// mail sink, and catch the redirect back to the client's loopback URI (no
// server listens there; Playwright answers it).
import { expect, type Page } from "@playwright/test";
import { REDIRECT } from "./oauth";
import { newestLink } from "./sink";

/** Fills the sign-in form for `email`; the page must be /sign-in. Returns the send time. */
export async function askForLink(page: Page, email: string): Promise<Date> {
  const since = new Date(Date.now() - 1_000);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page).toHaveURL(/\/sign-in\/sent/);
  return since;
}

/** Signs in from /sign-in and follows the link; the page ends wherever the link leads. */
export async function signIn(page: Page, email: string): Promise<void> {
  const since = await askForLink(page, email);
  await page.goto(await newestLink(email, since));
}

/** Answers the client's loopback redirect and resolves with its URL. */
export async function catchRedirect(page: Page): Promise<() => Promise<URL>> {
  let resolve!: (u: URL) => void;
  const caught = new Promise<URL>((r) => (resolve = r));
  await page.route(`${REDIRECT}**`, async (route) => {
    resolve(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: "text/plain", body: "client callback" });
  });
  return () => caught;
}
