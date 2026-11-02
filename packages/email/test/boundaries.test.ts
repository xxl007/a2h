// CLAUDE.md §Stack: AWS SDKs only inside apps/*/infra and infra/ (cold review
// of PR #51, task 10.5). This package holds the Mailer interface, the
// templates and the stage sink over an injected client; it neither imports
// nor depends on an AWS SDK. eslint.config.mjs enforces the same for every
// package under packages/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const AWS = /["'](?:@aws-sdk\/[^"']*|aws-sdk|@smithy\/[^"']*)["']/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "__snapshots__") continue;
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

test("no source, script or test of packages/email imports an AWS SDK", () => {
  const offenders = sources(ROOT)
    .filter((f) => !f.endsWith("boundaries.test.ts"))
    .filter((f) => /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:@aws-sdk\/|aws-sdk|@smithy\/)/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("package.json depends on no AWS SDK and exports no SES entry", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, Record<string, unknown> | undefined>;
  const deps = Object.keys({ ...pkg["dependencies"], ...pkg["devDependencies"], ...pkg["peerDependencies"] });
  assert.deepEqual(deps.filter((d) => AWS.test(JSON.stringify(d))), []);
  assert.equal(pkg["exports"]?.["./ses"], undefined);
});
