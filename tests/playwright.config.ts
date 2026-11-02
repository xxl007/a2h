// Web e2e against a live stage (A2H_WEB_URL). Chromium only, headless.
// Browsers: `pnpm --filter @a2h/tests exec playwright install chromium` once per machine.
import { defineConfig, devices } from "@playwright/test";
import { requireEnv } from "./src/live-env.ts";

const baseURL = requireEnv("A2H_WEB_URL", "https://<id>.cloudfront.net");
// In CI nothing is recorded (task 10.7): a trace holds the network log (magic links, session
// cookies, authorization codes), a video or screenshot the pages, and the repo is public.
// Locally a failure keeps its trace and screenshot for the developer.
const ci = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    headless: true,
    trace: ci ? "off" : "retain-on-failure",
    video: "off",
    screenshot: ci ? "off" : "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
