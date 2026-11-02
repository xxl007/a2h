// Sign-in on a live stage through the stage's mail sink (m1-hosted-connector
// task 6.2; spec platform/principal-identity "Allow-listed address",
// "Unknown address", "Expired or reused link", "Preview sign-in"). Uses
// tests/lib/mail-sink.ts with the deploy role (A2H_MAIL_SINK_BUCKET) or a
// local server's directory (A2H_MAIL_SINK_DIR). Needs A2H_TEST_EMAIL on the
// stage's allow-list (runbook aws-bootstrap.md §15). The full flows (consent,
// clients, revoke) are apps/web/test/e2e, run by the same verify job.
import { expect, test, type Page } from "@playwright/test";
import { expectedStage } from "../src/live-env.ts";
import { magicLinkOf, messagesTo, sinkClientFromEnv, waitForMagicLink, type SinkObjectClient } from "../lib/mail-sink.ts";

const STAGE = expectedStage();
const EMAIL = process.env["A2H_TEST_EMAIL"]?.trim();
const SINK = process.env["A2H_MAIL_SINK_BUCKET"] || process.env["A2H_MAIL_SINK_DIR"] ? sinkClientFromEnv() : undefined;

test.describe("principal sign-in through the mail sink", () => {
  test.skip(!EMAIL || !SINK, "needs A2H_TEST_EMAIL (allow-listed) and A2H_MAIL_SINK_BUCKET or A2H_MAIL_SINK_DIR");
  const sink = (): SinkObjectClient => SINK!.client;

  async function askForLink(page: Page, email: string): Promise<Date> {
    const since = new Date();
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page).toHaveURL(/\/sign-in\/sent$/);
    return since;
  }

  test("Scenario: Allow-listed address, Preview sign-in, Expired or reused link: one link in the sink, signs in once, refused the second time", async ({ page, browser }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to A2H");
    const since = await askForLink(page, EMAIL!);
    // No address in any URL (design: never in the query string).
    expect(page.url()).not.toContain(EMAIL!.split("@")[0]!);
    await expect(page.getByText(`Test stage ${STAGE}. Not the live service.`)).toBeVisible();
    await expect(page.getByText("On this test stage, links are not emailed")).toBeVisible();

    const link = await waitForMagicLink(sink(), STAGE, EMAIL!, since);
    const messages = await messagesTo(sink(), STAGE, EMAIL!, since);
    expect(messages, "exactly one message for this request").toHaveLength(1);
    expect(messages[0]!.subject).toBe(`[test stage ${STAGE}] Your A2H sign-in link`);
    expect(magicLinkOf(messages[0]!)).toBe(link);
    expect(messages[0]!.text).not.toContain(EMAIL!);
    expect(new URL(link).hostname).toBe(new URL(page.url()).hostname);

    await page.goto(link);
    await expect(page).toHaveURL(/\/account\/clients$/);
    await expect(page.getByText(`Signed in as ${EMAIL!}`)).toBeVisible();

    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      await second.goto(link);
      await expect(second).toHaveURL(/\/sign-in\/expired/);
      await expect(second.getByRole("heading", { level: 1 })).toHaveText("This sign-in link no longer works");
      await second.goto("/account/clients");
      await expect(second).toHaveURL(/\/sign-in/);
    } finally {
      await other.close();
    }
  });

  test("Scenario: Unknown address: the same page, nothing in the sink", async ({ page }) => {
    const stranger = `qa-stranger-${Date.now()}@a2h-protocol.org`;
    await page.goto("/sign-in");
    const since = await askForLink(page, stranger);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
    await expect(page.getByText(`If ${stranger} can sign in to A2H, a sign-in link is on its way to it.`)).toBeVisible();
    await page.waitForTimeout(3_000);
    expect(await messagesTo(sink(), STAGE, stranger, since)).toHaveLength(0);
  });
});
