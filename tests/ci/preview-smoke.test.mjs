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
    // Keys: "<path>" for any scheme, or "<scheme>:<path>" (checked first).
    // Values: "<status> <server> [<location>]".
    const entries = Object.entries(routes).sort(([a], [b]) => Number(b.includes(":")) - Number(a.includes(":")));
    const table = entries
      .map(([key, v]) => (key.includes(":") ? `  "${key}") set -- ${v} ;;` : `  *:"${key}") set -- ${v} ;;`))
      .join("\n");
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/usr/bin/env bash",
        'url="${*: -1}"',
        `echo "$url" >> "${dir}/urls"`,
        `path="/\${url#*://*/}"`,
        'scheme="${url%%://*}"',
        'case "$scheme:$path" in',
        table,
        '  *) set -- 403 awselb/2.0 ;;',
        "esac",
        'printf "HTTP/1.1 %s X\\r\\nServer: %s\\r\\n" "$1" "$2"',
        '[ -n "${3:-}" ] && printf "Location: %s\\r\\n" "$3"',
        'printf "\\r\\n"',
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

// m1-hosted-connector task 1.2: the deploy outputs become
// https://mcp.dev.a2h-protocol.org/..., and the workflows pass the base URL
// with its scheme. Spec platform/hosted-endpoint "HTTP redirected".
const HOST = "mcp.dev.a2h-protocol.org";

test("a base URL with https:// is probed over HTTPS, and plain HTTP must answer 301 to HTTPS", () => {
  const r = smoke([`https://${HOST}`, "dev"], {
    "https:/healthz": "200 -",
    "http:/healthz": `301 awselb/2.0 https://${HOST}:443/healthz`,
  });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.urls, [`https://${HOST}/healthz`, `http://${HOST}/healthz`]);
  assert.match(r.out, /ok {3}HTTP redirected/);
  assert.match(r.out, new RegExp(`--cli https://${HOST}/mcp `));
});

test("preview over HTTPS: health, dev health, routing and the redirect of the preview path", () => {
  const r = smoke([`https://${HOST}`, "12"], {
    "https:/pr-12/healthz": "200 -",
    "https:/healthz": "200 -",
    "https:/pr-12/nope": "404 -",
    "http:/pr-12/healthz": `301 awselb/2.0 https://${HOST}/pr-12/healthz`,
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`https://${HOST}/pr-12/mcp`));
});

test("HTTPS: plain HTTP serving 200 instead of redirecting fails the smoke", () => {
  const r = smoke([`https://${HOST}`, "dev"], { "/healthz": "200 -" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL HTTP redirected/);
});

test("HTTPS: a redirect to anything but the same URL over HTTPS fails the smoke", () => {
  for (const location of [`http://${HOST}/healthz`, `https://evil.example/healthz`, `https://${HOST}/`]) {
    const r = smoke([`https://${HOST}`, "dev"], { "https:/healthz": "200 -", "http:/healthz": `301 awselb/2.0 ${location}` });
    assert.equal(r.status, 1, `${location}: ${r.out}`);
    assert.match(r.out, /FAIL HTTP redirected/);
  }
});

test("HTTPS: a 302 is not a permanent redirect", () => {
  const r = smoke([`https://${HOST}`, "dev"], {
    "https:/healthz": "200 -",
    "http:/healthz": `302 awselb/2.0 https://${HOST}/healthz`,
  });
  assert.equal(r.status, 1, r.out);
});

test("a base URL with a path or another scheme is a usage error", () => {
  for (const bad of [`https://${HOST}/mcp`, `ftp://${HOST}`, "https://"]) {
    const r = smoke([bad, "dev"], {});
    assert.equal(r.status, 2, `${bad}: ${r.out}`);
  }
});

test("a bare host keeps the old behaviour: http, no redirect check", () => {
  const r = smoke([ALB, "dev"], { "/healthz": "200 -" });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /HTTP redirected/);
});
