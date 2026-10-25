import { defineConfig } from "vitest/config";

// Next.js needs `"jsx": "preserve"` in tsconfig.json; tests compile JSX with
// React's automatic runtime instead (what Next itself does at build time).
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node" },
});
