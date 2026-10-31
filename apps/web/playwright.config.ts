// Sign-in, consent and client-registration flows against a running stage
// (m1-hosted-connector group 5). Needs:
//   A2H_WEB_URL   the stage's web URL (preview: from the PR comment)
//   A2H_MCP_URL   the stage's MCP URL (the `resource` tokens are bound to)
//   the mail sink: A2H_MAIL_SINK_DIR (a local server's LOCAL_MAIL_DIR) or
//   A2H_MAIL_SINK_BUCKET with AWS credentials allowed to read
//   tmp/<stage>/mail/ (the deploy role), and A2H_STAGE (e.g. pr-57);
//   A2H_TEST_EMAIL, A2H_TEST_EMAIL_2: two allow-listed addresses.
// QA's shared sink helper (task 6.2) replaces test/e2e/lib/sink.ts.
// Browsers: `pnpm --filter @a2h/web exec playwright install chromium`.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: process.env["A2H_WEB_URL"] ?? "http://localhost:3210",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
