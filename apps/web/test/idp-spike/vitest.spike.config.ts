import { defineConfig } from "vitest/config";

// SPIKE: run from apps/web with
//   pnpm exec vitest run --config test/idp-spike/vitest.spike.config.ts
// Postgres comes from the web tests' global setup; Keycloak from
// keycloak/start.sh (or A2H_KEYCLOAK_URL for one already running).
export default defineConfig({
  root: new URL("../..", import.meta.url).pathname,
  test: {
    include: ["test/idp-spike/**/*.spike.ts"],
    environment: "node",
    globalSetup: ["test/lib/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
