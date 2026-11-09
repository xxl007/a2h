// m2-attachments task 3.2 (ADR 0005 items 4 and 5): the provider-neutral scan
// result the worker codes against, and the object key layout of a file
// (design D2, D3) shared by the web app (presigned POST) and the worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FILE_SCAN_OUTCOMES, FileScanResultSchema, fileObjectKey, parseFileObjectKey } from "../src/index.ts";

const FILE = "fAAAAAAAAAAAAAAAAAAAAAA";
const REQUEST = "A2H-7f3c";

test("FileScanResult is { file_id, outcome } with outcome clean | threat | error, closed", () => {
  assert.deepEqual([...FILE_SCAN_OUTCOMES], ["clean", "threat", "error"]);
  for (const outcome of FILE_SCAN_OUTCOMES) assert.ok(FileScanResultSchema.safeParse({ file_id: FILE, outcome }).success);
  assert.ok(!FileScanResultSchema.safeParse({ file_id: FILE, outcome: "infected" }).success);
  assert.ok(!FileScanResultSchema.safeParse({ file_id: "report.pdf", outcome: "clean" }).success, "an opaque file id only");
  // No room for a detection name, a hash or a reason: the shape is closed.
  assert.ok(!FileScanResultSchema.safeParse({ file_id: FILE, outcome: "threat", threat: "EICAR-Test-File" }).success);
});

test("object keys: <area>/<STORAGE_PREFIX>files/<request_id>/<file_id>", () => {
  assert.equal(fileObjectKey("tmp", "pr-12/", REQUEST, FILE), `tmp/pr-12/files/${REQUEST}/${FILE}`);
  assert.equal(fileObjectKey("uploads", "dev/", REQUEST, FILE), `uploads/dev/files/${REQUEST}/${FILE}`);
  assert.throws(() => fileObjectKey("tmp", "pr-12", REQUEST, FILE), /prefix/);
  assert.throws(() => fileObjectKey("tmp", "pr-12/", "../x", FILE), /request/);
  assert.throws(() => fileObjectKey("tmp", "pr-12/", REQUEST, "report.pdf"), /file/);
});

test("parseFileObjectKey reads a key of this stage only, and nothing else", () => {
  assert.deepEqual(parseFileObjectKey(`tmp/pr-12/files/${REQUEST}/${FILE}`, "pr-12/"), { area: "tmp", request_id: REQUEST, file_id: FILE });
  assert.deepEqual(parseFileObjectKey(`uploads/pr-12/files/${REQUEST}/${FILE}`, "pr-12/"), { area: "uploads", request_id: REQUEST, file_id: FILE });
  for (const key of [
    `tmp/pr-120/files/${REQUEST}/${FILE}`, // another preview
    `tmp/dev/files/${REQUEST}/${FILE}`, // dev
    `tmp/pr-12/mail/${FILE}.json`, // the mail sink
    `tmp/pr-12/files/${REQUEST}/${FILE}/x`,
    `tmp/pr-12/files/${REQUEST}/report.pdf`,
    `malware-protection-resource-validation-object`,
    `other/pr-12/files/${REQUEST}/${FILE}`,
  ]) {
    assert.equal(parseFileObjectKey(key, "pr-12/"), null, key);
  }
});
