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
        // Test files under apps/*/test are outside their package's tsconfig
        // (which builds src/ only) and are typed by the base config instead.
        projectService: {
          allowDefaultProject: ["apps/*/test/*.ts"],
          defaultProject: "tsconfig.base.json",
        },
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
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
