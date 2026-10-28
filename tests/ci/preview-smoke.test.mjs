// Behaviour of tests/ci/preview-smoke.sh against a fake curl (no network).
// Spec: openspec/changes/ci-preview-verify/specs/platform/preview-environments/spec.md
// ("Preview verified", "Merge to main verified": the smoke check of each stage).
// Run: node --test tests/ci/preview-smoke.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";

const SCRIPT = fileURLToPath(new URL("./preview-smoke.sh", import.meta.url));
const ALB = "AlbLoadBalancer-x.eu-west-3.elb.amazonaws.com";

/** routes: { "<path>": "<status> <server>" }; anything else is a 403 from the ALB. */
function smoke(args, routes) {
  const dir = mkdtempSync(join(tmpdir(), "a2h-smoke-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const table = Object.entries(routes)
      .map(([path, v]) => `  "${path}") set -- ${v} ;;`)
      .join("\n");
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/usr/bin/env bash",
        'url="${*: -1}"',
        `echo "$url" >> "${dir}/urls"`,
        `path="/\${url#*://*/}"`,
        'case "$path" in',
        table,
        '  *) set -- 403 awselb/2.0 ;;',
        "esac",
        'printf "HTTP/1.1 %s X\\r\\nServer: %s\\r\\n\\r\\n" "$1" "$2"',
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "urls"), "");
    const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}` } });
    return { status: r.status, out: r.stdout + r.stderr, urls: readFileSync(join(dir, "urls"), "utf8").split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("preview mode passes when preview health, dev health and the app's 404 answer", () => {
  const r = smoke([ALB, "12"], { "/pr-12/healthz": "200 -", "/healthz": "200 -", "/pr-12/nope": "404 -" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\/pr-12\/mcp/);
});

test("preview mode fails on the ALB's 403 (no listener rule)", () => {
  const r = smoke([ALB, "12"], { "/healthz": "200 -" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL preview health/);
});

test("dev mode checks /healthz and passes on 200", () => {
  const r = smoke([ALB, "dev"], { "/healthz": "200 -" });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.urls, [`http://${ALB}/healthz`]);
  assert.match(r.out, /ok {3}dev health/);
  assert.match(r.out, new RegExp(`http://${ALB}/mcp`));
  assert.doesNotMatch(r.out, /pr-/);
});

test("dev mode fails when /healthz does not answer 200", () => {
  const r = smoke([ALB, "dev"], { "/healthz": "503 -" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL dev health/);
});

test("anything but a PR number or dev is a usage error", () => {
  for (const bad of ["0", "prod", "pr-12", ""]) {
    const r = smoke([ALB, bad], {});
    assert.equal(r.status, 2, `${bad}: ${r.out}`);
  }
});
