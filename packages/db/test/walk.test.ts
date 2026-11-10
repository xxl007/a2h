// m2-attachments review B2: the seed test's walk over tests/ and apps/web
// must never enter node_modules or a dot-directory. It used to recurse into
// everything and filter afterwards, so a directory another check created and
// deleted meanwhile (a drizzle temp dir under node_modules) failed it with
// ENOENT. Here an unreadable directory stands in for one that vanishes: a
// walk that enters it throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { sourceFiles } from "./lib/walk.ts";

test("sourceFiles lists source files and never enters node_modules, dot-directories or build output", (t) => {
  const root = mkdtempSync(join(tmpdir(), "a2h-walk-"));
  t.after(() => {
    for (const d of ["node_modules/pkg/gone", ".turbo/gone"]) chmodSync(join(root, d), 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src/deep"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "");
  writeFileSync(join(root, "src/deep/b.tsx"), "");
  writeFileSync(join(root, "src/deep/notes.md"), "");
  for (const d of ["node_modules/pkg/gone", ".turbo/gone", "dist", ".next"]) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, "x.ts"), "");
  }
  chmodSync(join(root, "node_modules/pkg/gone"), 0o000);
  chmodSync(join(root, ".turbo/gone"), 0o000);
  const found = sourceFiles(root, new Set(["node_modules", "dist", ".next"])).map((p) => relative(root, p)).sort();
  assert.deepEqual(found, ["src/a.ts", "src/deep/b.tsx"]);
});
