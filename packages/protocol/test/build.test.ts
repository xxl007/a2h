// Task 2.8 / design D5: the package builds to ESM that plain Node loads (no
// type stripping: Node does not strip .ts under node_modules), and its
// exports map points at the built files.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
// Inside the package so that `zod` resolves from the emitted files as it will from dist/.
const outDir = fileURLToPath(new URL("../node_modules/.cache/build-test/", import.meta.url));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

before(() => {
  rmSync(outDir, { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", outDir], { cwd: pkgDir, stdio: "pipe" });
});

test("tsconfig.build.json emits ESM .js and .d.ts for every source file", () => {
  const sources = readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".ts"));
  const emitted = new Set(readdirSync(outDir));
  for (const src of sources) {
    const base = src.replace(/\.ts$/, "");
    assert.ok(emitted.has(`${base}.js`), `${base}.js`);
    assert.ok(emitted.has(`${base}.d.ts`), `${base}.d.ts`);
  }
});

test("relative imports in the emitted JavaScript end in .js (no .ts left for Node to choke on)", () => {
  for (const f of readdirSync(outDir).filter((n) => n.endsWith(".js"))) {
    const text = readFileSync(`${outDir}${f}`, "utf8");
    assert.doesNotMatch(text, /from "\.\/[^"]+\.ts"/, f);
  }
});

test("a TypeScript consumer gets real types from the emitted declarations", () => {
  // tsc keeps `./x.ts` specifiers in .d.ts output and resolves them to the
  // sibling .d.ts; prove it: the one deliberate type error must be reported,
  // which only happens if Manifest resolved to its real shape (not any).
  const dir = fileURLToPath(new URL("../node_modules/.cache/build-test-consumer/", import.meta.url));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}use.ts`,
    [
      `import { type Manifest, validateManifest } from ${JSON.stringify(`${outDir}index.js`)};`,
      `const ok: Manifest["bid_minor"] = 3000;`,
      `const bad: Manifest["bid_minor"] = "3000";`,
      `void ok; void bad; void validateManifest;`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    `${dir}tsconfig.json`,
    JSON.stringify({ extends: fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url)), compilerOptions: { noEmit: true, types: [] }, include: ["use.ts"] }),
  );
  let output = "";
  try {
    execFileSync(process.execPath, [tsc, "-p", `${dir}tsconfig.json`], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    output = String((e as { stdout?: string }).stdout ?? "");
  }
  const errors = output.split("\n").filter((l) => l.includes("error TS"));
  assert.equal(errors.length, 1, output);
  assert.match(errors[0] ?? "", /use\.ts\(3,\d+\): error TS2322/);
});

test("plain Node imports the built entry point and gets the public API", () => {
  const script = `import(${JSON.stringify(`${outDir}index.js`)}).then((m) => console.log(JSON.stringify(Object.keys(m).sort())))`;
  const out = execFileSync(process.execPath, ["--no-experimental-strip-types", "-e", script], { cwd: pkgDir, encoding: "utf8" });
  const keys = JSON.parse(out) as string[];
  for (const name of ["ManifestSchema", "validateManifest", "canonicalAnswerPayload", "signAnswer", "verifyAnswer", "gross", "net", "clear", "formatRequestId", "toolJsonSchemas", "transition"]) {
    assert.ok(keys.includes(name), name);
  }
});

test("package.json exports map points at dist/ only and ships dist/", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.exports, { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } });
  assert.deepEqual(pkg.files, ["dist"]);
  assert.equal((pkg.scripts as Record<string, string>).build, "tsc -p tsconfig.build.json");
  assert.equal("main" in pkg, false, "no main pointing at src/");
});
