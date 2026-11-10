// Behaviour of .github/scripts/storage-cors.sh against a fake curl (no network):
// the CORS preflight the verify jobs send to decide whether the file tests
// must run (m2-attachments task 6.1).
// Run: node --test tests/ci/storage-cors.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";

const SCRIPT = fileURLToPath(new URL("../../.github/scripts/storage-cors.sh", import.meta.url));
const BUCKET = "a2h-uploads-123456789012";
const ORIGIN = "https://pr-112.dev.a2h-protocol.org";

/** `response`: the raw header block the fake curl prints with -D -, or null for a network failure. */
function probe(args, response) {
  const dir = mkdtempSync(join(tmpdir(), "a2h-cors-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "response"), response ?? "");
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> "${dir}/calls"`,
        response === null ? "exit 7" : `cat "${dir}/response"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "calls"), "");
    const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}` } });
    return { status: r.status, out: r.stdout + r.stderr, calls: readFileSync(join(dir, "calls"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const allowed = (origin, methods = "POST") =>
  `HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: ${origin}\r\nAccess-Control-Allow-Methods: ${methods}\r\nAccess-Control-Max-Age: 3600\r\n\r\n`;

test("allowed: 200, the origin echoed, POST among the methods → exit 0, one line", () => {
  const r = probe([BUCKET, ORIGIN], allowed(ORIGIN));
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), `storage-cors: allowed (POST from ${ORIGIN})`);
});

test("the preflight: OPTIONS to the bucket's regional endpoint with Origin and the POST method, nothing else", () => {
  const r = probe([BUCKET, ORIGIN], allowed(ORIGIN));
  assert.match(r.calls, /-X OPTIONS/);
  assert.match(r.calls, new RegExp(`Origin: ${ORIGIN.replace(/\./g, "\\.")}`));
  assert.match(r.calls, /Access-Control-Request-Method: POST/);
  assert.match(r.calls, new RegExp(`https://${BUCKET}\\.s3\\.eu-west-3\\.amazonaws\\.com/$`, "m"));
  assert.doesNotMatch(r.calls, /Authorization|X-Amz-/i, "no credentials are sent");
});

test("allowed with a wildcard origin and several methods (lower-case headers too)", () => {
  const r = probe([BUCKET, ORIGIN], "HTTP/1.1 200 OK\r\naccess-control-allow-origin: *\r\naccess-control-allow-methods: GET, PUT, POST\r\n\r\n");
  assert.equal(r.status, 0, r.out);
});

test("refused: today's dev bucket (CORS GET and PUT from *, no POST) → exit 1 with the reason", () => {
  const r = probe([BUCKET, ORIGIN], "HTTP/1.1 403 Forbidden\r\nContent-Type: application/xml\r\n\r\n");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /refused \(HTTP 403; POST from https:\/\/pr-112\.dev\.a2h-protocol\.org is not in the bucket's CORS\)/);
});

test("refused: 200 for another origin, or without POST", () => {
  assert.equal(probe([BUCKET, ORIGIN], allowed("https://dev.a2h-protocol.org")).status, 1);
  assert.equal(probe([BUCKET, ORIGIN], allowed(ORIGIN, "GET, PUT")).status, 1);
  assert.equal(probe([BUCKET, ORIGIN], allowed(ORIGIN, "POSTX")).status, 1);
});

test("no answer → exit 2; bad arguments → exit 2 without a request", () => {
  assert.equal(probe([BUCKET, ORIGIN], null).status, 2);
  for (const args of [[], [BUCKET], [BUCKET, `${ORIGIN}/approve`], ["Bad_Bucket", ORIGIN], [BUCKET, "pr-112.dev.a2h-protocol.org"]]) {
    const r = probe(args, allowed(ORIGIN));
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.out}`);
    assert.equal(r.calls, "", `${JSON.stringify(args)}: a request was sent`);
  }
});
