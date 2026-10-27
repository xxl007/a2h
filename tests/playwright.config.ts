// Web e2e against a live stage (A2H_WEB_URL). Chromium only, headless.
// Browsers: `pnpm --filter @a2h/tests exec playwright install chromium` once per machine.
import { defineConfig, devices } from "@playwright/test";
import { requireEnv } from "./src/live-env.ts";

const baseURL = requireEnv("A2H_WEB_URL", "https://<id>.cloudfront.net");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
