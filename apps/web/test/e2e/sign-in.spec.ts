// Task 5.3 on a stage: spec principal-identity "Sign-in by magic link to an
// allow-listed address" (three scenarios) and "Magic links leave production
// only through email" / "Preview sign-in" (the link is in the stage's sink).
import { expect, test } from "@playwright/test";
import { EMAIL, STAGE } from "./lib/env";
import { askForLink, signIn } from "./lib/browser";
import { messagesTo, newestLink } from "./lib/sink";

test("Scenario: Allowed address: one link, at most 15 minutes, single use; the address never in the URL", async ({ page, browser }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to A2H");
  await expect(page).toHaveTitle("Sign in · A2H");
  const since = await askForLink(page, EMAIL);
  expect(page.url()).not.toContain(encodeURIComponent(EMAIL));
  expect(page.url()).not.toContain(EMAIL);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
  await expect(page.getByText(`If ${EMAIL} can sign in to A2H, a sign-in link is on its way to it.`)).toBeVisible();
  await expect(page.getByText(`Test stage ${STAGE}. Not the live service.`)).toBeVisible();

  const link = await newestLink(EMAIL, since);
  const messages = await messagesTo(EMAIL, since);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.subject).toBe(`[test stage ${STAGE}] Your A2H sign-in link`);
  expect(messages[0]!.text).toContain("It works once and for 15 minutes.");

  await page.goto(link);
  await expect(page).toHaveURL(/\/account\/clients$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connected apps");
  await expect(page.getByText(`Signed in as ${EMAIL}`)).toBeVisible();

  // Scenario: Expired or reused link: a second use, in another browser, is refused with the resend offer.
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto(link);
  await expect(second).toHaveURL(/\/sign-in\/expired/);
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("This sign-in link no longer works");
  await expect(second.getByRole("link", { name: "Send me a new link" })).toHaveAttribute("href", "/sign-in");
  await second.goto("/account/clients");
  await expect(second).toHaveURL(/\/sign-in/);
  await other.close();
});

test("Scenario: Unknown address: the same page, no link in the sink", async ({ page }) => {
  const stranger = `stranger-${Date.now()}@example.org`;
  await page.goto("/sign-in");
  const since = await askForLink(page, stranger);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
  await expect(page.getByText(`If ${stranger} can sign in to A2H, a sign-in link is on its way to it.`)).toBeVisible();
  // React Aria's generated ids differ per render; everything else must be identical.
  const normalize = (html: string, address: string) => html.replaceAll(address, "{address}").replace(/id="react-aria[^"]*"/g, 'id=""');
  const unknownHtml = normalize(await page.locator("main").innerHTML(), stranger);

  const known = await page.context().browser()!.newContext();
  const kp = await known.newPage();
  await kp.goto("/sign-in");
  await askForLink(kp, EMAIL);
  const knownHtml = normalize(await kp.locator("main").innerHTML(), EMAIL);
  await known.close();
  expect(unknownHtml).toBe(knownHtml);

  await new Promise((r) => setTimeout(r, 3_000));
  expect(await messagesTo(stranger, since)).toHaveLength(0);
});

test("Send another link: the same notice for any address; the newest link works", async ({ page }) => {
  await page.goto("/sign-in");
  const since = await askForLink(page, EMAIL);
  await newestLink(EMAIL, since);
  await page.getByRole("button", { name: "Send another link" }).click();
  await expect(page.getByText("Another link is on its way")).toBeVisible();
  await expect.poll(async () => (await messagesTo(EMAIL, since)).length, { timeout: 20_000 }).toBe(2);
  const newest = await newestLink(EMAIL, since);
  await page.goto(newest);
  await expect(page).toHaveURL(/\/account\/clients$/);
});

test("Sign out revokes the session: /account/clients asks to sign in again", async ({ page }) => {
  await page.goto("/sign-in");
  await signIn(page, EMAIL);
  await expect(page).toHaveURL(/\/account\/clients$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signed-out$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're signed out");
  await page.goto("/account/clients");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount%2Fclients/);
});

test("invalid address: the field says what to do and keeps the value", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill("name@");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Error: Enter an email address in the form name@example.com.")).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveValue("name@");
});
