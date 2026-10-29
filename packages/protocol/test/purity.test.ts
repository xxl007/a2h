// Task 2.9; spec protocol/schemas "The package performs no I/O" and its
// scenario "Works without any environment".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const pkgDir = fileURLToPath(new URL("../", import.meta.url));
// An existing source file: the type-aware lint needs a path the project knows; the text is ours.
const probePath = fileURLToPath(new URL("../src/primitives.ts", import.meta.url));

async function lint(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, { filePath: probePath });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? "fatal"}: ${m.message}`);
}

describe("ESLint purity rules on packages/protocol/src", () => {
  const violations: [string, string, string][] = [
    ["a node: import", `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`, "no-restricted-imports"],
    ["a bare builtin import", `import * as fs from "fs";\nexport const x = fs;\n`, "no-restricted-imports"],
    ["a database driver import", `import pg from "pg";\nexport const x = pg;\n`, "no-restricted-imports"],
    ["Date.now()", `export const t = Date.now();\n`, "no-restricted-properties"],
    ["Math.random()", `export const r = Math.random();\n`, "no-restricted-properties"],
    ["new Date() without an argument", `export const d = new Date();\n`, "no-restricted-syntax"],
    ["crypto.getRandomValues", `export const b = globalThis.crypto.getRandomValues(new Uint8Array(2));\n`, "no-restricted-syntax"],
    ["key generation", `export const k = globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]);\n`, "no-restricted-syntax"],
    ["fetch", `export const f = fetch("https://example.org");\n`, "no-restricted-globals"],
    ["process", `export const e = process.env.SECRET;\n`, "no-restricted-globals"],
    ["setTimeout", `export const s = setTimeout(() => undefined, 1);\n`, "no-restricted-globals"],
    ["a dynamic import", `export const m = import("./money.ts");\n`, "no-restricted-syntax"],
  ];
  for (const [name, code, rule] of violations) {
    test(`a deliberate violation fails the lint: ${name}`, async () => {
      const messages = await lint(code);
      assert.ok(messages.some((m) => m.startsWith(`${rule}:`)), `expected ${rule}, got ${JSON.stringify(messages)}`);
    });
  }
  test("allowed: zod, relative imports, Date.parse and new Date(value)", async () => {
    const messages = await lint(
      `import * as z from "zod";\nimport { gross } from "./money.ts";\nexport const a = z.string();\nexport const b = gross;\nexport const c = Date.parse("2026-10-21T08:42:00Z");\nexport const d = new Date(c).toISOString();\n`,
    );
    assert.deepEqual(messages, []);
  });
  test("the package itself passes the purity rules", () => {
    // In its own process: the probes above replaced src/primitives.ts's text in this process's project service.
    const bin = fileURLToPath(import.meta.resolve("eslint").replace(/lib\/api\.js$/, "bin/eslint.js"));
    const out = execFileSync(process.execPath, [bin, "--format", "json", "src"], { cwd: pkgDir, encoding: "utf8" });
    const results = JSON.parse(out) as { filePath: string; messages: { ruleId: string | null; message: string }[] }[];
    assert.ok(results.length >= 10, "src files were linted");
    assert.deepEqual(results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.ruleId ?? "fatal"}: ${m.message}`)), []);
  });
});

describe("Scenario: Works without any environment", () => {
  test("every exported function produces its result with clock, randomness, network, timers and fs writes unavailable", () => {
    const harness = fileURLToPath(new URL("./purity/run-without-environment.ts", import.meta.url));
    const out = execFileSync(
      process.execPath,
      ["--permission", `--allow-fs-read=${repoRoot}`, "--import", fileURLToPath(new URL("./purity/deny-environment.ts", import.meta.url)), harness],
      { cwd: pkgDir, encoding: "utf8" },
    );
    const report = JSON.parse(out) as { called: string[]; uncalled: string[] };
    assert.deepEqual(report.uncalled, [], "every exported function is exercised");
    assert.ok(report.called.length >= 20, `called ${report.called.length}`);
  });
});
