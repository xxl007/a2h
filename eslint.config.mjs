// One root flat config for every workspace package (task 4.11).
// Each package runs `eslint .`; ESLint finds this file by walking up.
// Correctness only: @eslint/js recommended + typescript-eslint
// recommendedTypeChecked, with promise misuse as errors. No stylistic rules
// (formatting is out of scope).
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/dist/",
    "**/.sst/",
    "**/.open-next/",
    "**/.next/",
    "**/node_modules/",
    "**/coverage/",
    "**/.turbo/",
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Each file is typed by the nearest tsconfig.json, as `tsc` does.
        // Every linted .ts file must be in its package's tsconfig.json
        // (apps include src and test; build emits from tsconfig.build.json).
        // No default project: a file outside every tsconfig is an error,
        // not silently typed against the repo root.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // node:test's test()/describe() return a promise the runner itself
      // tracks; awaiting them at top level is not required or idiomatic.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "it", "describe", "suite"] },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // sst.config.ts sits at the root, where there is no tsconfig.json; it is
    // typed by infra/tsconfig.json (with the SST globals from
    // .sst/platform/config.d.ts), exactly as `pnpm typecheck` types it.
    files: ["sst.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["./infra/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // packages/protocol is pure (spec protocol/schemas "The package performs
    // no I/O", task 2.9): no Node or third-party module but zod, no clock, no
    // randomness, no network, no timers, no key generation. Ids, times and
    // keys are arguments. packages/protocol/test/purity.test.ts proves each
    // rule fires on a deliberate violation.
    files: ["packages/protocol/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!zod$|\\./)",
              message: "packages/protocol is pure: import only zod and sibling files (no node:, no I/O, no SDK).",
            },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "No clock in packages/protocol: pass the time in." },
        { object: "Math", property: "random", message: "No randomness in packages/protocol: pass the bytes in." },
        { object: "performance", property: "now", message: "No clock in packages/protocol." },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "process",
          "fetch",
          "XMLHttpRequest",
          "WebSocket",
          "EventSource",
          "require",
          "Buffer",
          "setTimeout",
          "setInterval",
          "setImmediate",
          "queueMicrotask",
          "localStorage",
          "sessionStorage",
          "indexedDB",
          "navigator",
          "performance",
        ].map((name) => ({ name, message: "packages/protocol is pure: no environment access." })),
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "No clock in packages/protocol: pass the time in." },
        { selector: "CallExpression[callee.name='Date']", message: "No clock in packages/protocol: pass the time in." },
        { selector: "MemberExpression[property.name=/^(getRandomValues|randomUUID)$/]", message: "No randomness in packages/protocol: pass the bytes in." },
        { selector: "MemberExpression[property.name=/^(generateKey|deriveKey|exportKey|wrapKey|unwrapKey)$/]", message: "packages/protocol never creates or exports keys: keys are arguments." },
        { selector: "ImportExpression", message: "No dynamic import in packages/protocol." },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
