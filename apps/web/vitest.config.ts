import { defineConfig } from "vitest/config";

// Next.js needs `"jsx": "preserve"` in tsconfig.json; tests compile JSX with
// React's automatic runtime instead (what Next itself does at build time).
// One PostgreSQL container per run (test/lib/global-setup.ts); test/e2e holds
// the Playwright flows, run with `pnpm e2e`, not by vitest.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["test/e2e/**", "node_modules/**"],
    environment: "node",
    globalSetup: ["test/lib/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
