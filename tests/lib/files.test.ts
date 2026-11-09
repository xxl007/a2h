// The file fixtures and the local stage's fake scanner (m2-attachments task
// 6.3), checked without a stage: every committed fixture is small and is
// what its name says by the worker's own content check; the large files are
// generated to the byte; the EICAR string exists only at run time; and what
// the fake scanner writes is read by the worker's real SQS adapter as the
// events AWS would send.
// Run: node --test lib/files.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sniffFile } from "../../apps/worker/src/files/sniff.ts";
import { fileEventOf } from "../../apps/worker/infra/file-events.ts";
import { objectCreated, scanResult, SCAN_UNSUPPORTED_MARKER, SCAN_WITHHOLD_MARKER } from "../local/fake-scanner.ts";
import { actionResult, eicar, F, KB, MB, pdfOfSize, pngOfSize, textOfSize } from "./files.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/files/", import.meta.url));
const TESTS = fileURLToPath(new URL("../", import.meta.url));

test("every committed fixture is under 1 KB (nothing over 1 MB is committed)", () => {
  const names = readdirSync(FIXTURES);
  assert.ok(names.length >= 9, `fixtures: ${names.join(", ")}`);
  for (const n of names) assert.ok(statSync(join(FIXTURES, n)).size < KB, `${n} is ${statSync(join(FIXTURES, n)).size} bytes`);
});

test("the allowed fixtures are their declared type by the worker's content check", () => {
  for (const f of [F.pdf(), F.png(), F.jpeg(), F.webp(), F.text(), F.csv(), F.markdown()]) {
    assert.deepEqual(sniffFile(f.buffer, f.mimeType), { ok: true, media_type: f.mimeType }, f.name);
  }
});

test("the refused fixtures are refused by the worker's content check: HTML named and declared as a PDF, a ZIP, an executable", () => {
  for (const f of [F.disguisedHtml(), F.zip(), F.exe()]) assert.deepEqual(sniffFile(f.buffer, f.mimeType), { ok: false }, f.name);
  // The disguised file is refused whatever text type it would claim too.
  assert.deepEqual(sniffFile(F.disguisedHtml().buffer, "text/plain"), { ok: false });
});

test("generated files have exactly the size asked and keep their type", () => {
  for (const [f, size] of [[pdfOfSize(2 * MB), 2 * MB], [pngOfSize(300 * KB), 300 * KB], [textOfSize(3 * MB), 3 * MB], [pdfOfSize(25 * MB + 1), 25 * MB + 1]] as const) {
    assert.equal(f.buffer.length, size, f.name);
    assert.deepEqual(sniffFile(f.buffer.subarray(0, 8192), f.mimeType, { truncated: f.buffer.length > 8192 }), { ok: true, media_type: f.mimeType }, f.name);
  }
});

test("EICAR: the standard 68-byte test string, built at run time; no file under tests/ holds it whole", () => {
  const s = eicar();
  assert.equal(s.length, 68);
  assert.ok(s.startsWith("X5O!P%@AP[4\\PZX54(P^)7CC)7}$") && s.endsWith("$H+H*"));
  assert.equal(F.eicar().name, "notes.txt");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name.startsWith(".") || e.name === "test-results" ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const holders = walk(TESTS).filter((p) => readFileSync(p, "latin1").includes(s));
  assert.deepEqual(holders, []);
});

test("actionResult reads a server action's answer, including strings React sends as text rows (a deployed stage's long policies)", () => {
  // Local: everything inline.
  assert.deepEqual(actionResult('0:{"a":"$@1","f":"","b":"x"}\n1:{"kind":"refused","refusal":"count"}\n'), { kind: "refused", refusal: "count" });
  // Deployed (session token in the policy): long strings become `id:T<hex byte length>,<text>` rows, with no newline after them,
  // referenced as "$id"; "$$" escapes a string that starts with "$".
  const policy = "P".repeat(1500);
  const token = "é".repeat(600); // multibyte: the length is in bytes
  const text =
    `0:{"a":"$@1","f":"","b":"x"}\n` +
    `2:T${Buffer.byteLength(policy).toString(16)},${policy}` +
    `3:T${Buffer.byteLength(token).toString(16)},${token}` +
    `1:{"kind":"added","file":{"id":"fA","name":"$$5 notes.pdf"},"upload":{"url":"https://b.s3/","fields":{"Policy":"$2","X-Amz-Security-Token":"$3"}}}\n`;
  assert.deepEqual(actionResult(text), {
    kind: "added",
    file: { id: "fA", name: "$5 notes.pdf" },
    upload: { url: "https://b.s3/", fields: { Policy: policy, "X-Amz-Security-Token": token } },
  });
  assert.deepEqual(actionResult('0:{"a":"$@1"}\n1:{"url":null}\n'), { url: null });
  assert.equal(actionResult("<html>502</html>"), undefined);
});

test("the fake scanner's events read, through the worker's real adapter, as AWS's would", () => {
  const o = { bucket: "a2h-uploads-local", storagePrefix: "pr-12/" };
  const key = "tmp/pr-12/files/A2H-7f3c/fAAAAAAAAAAAAAAAAAAAAAA";
  assert.deepEqual(fileEventOf(objectCreated(o.bucket, key, 10), o).event, { kind: "created", file_id: "fAAAAAAAAAAAAAAAAAAAAAA" });
  assert.deepEqual(fileEventOf(scanResult(o.bucket, key, "NO_THREATS_FOUND"), o).event, { kind: "scanned", result: { file_id: "fAAAAAAAAAAAAAAAAAAAAAA", outcome: "clean" } });
  const threat = fileEventOf(scanResult(o.bucket, key, "THREATS_FOUND"), o);
  assert.deepEqual(threat.event, { kind: "scanned", result: { file_id: "fAAAAAAAAAAAAAAAAAAAAAA", outcome: "threat" } });
  assert.doesNotMatch(JSON.stringify(threat), /EICAR/, "the detection name stops at the adapter");
  const unsupported = fileEventOf(scanResult(o.bucket, key, "UNSUPPORTED"), o);
  assert.deepEqual(unsupported.event, { kind: "scanned", result: { file_id: "fAAAAAAAAAAAAAAAAAAAAAA", outcome: "error" } });
  assert.equal(unsupported.log["reason"], "PASSWORD_PROTECTED");
  // Another stage's key is ignored, as on a deployed stage.
  assert.equal(fileEventOf(objectCreated(o.bucket, key.replace("pr-12/", "pr-13/"), 10), o).event, null);
  assert.notEqual(SCAN_WITHHOLD_MARKER, SCAN_UNSUPPORTED_MARKER);
});
