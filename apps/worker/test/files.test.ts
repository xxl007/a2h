// m2-attachments task 3.2 (design D3, D5; ADR 0005 item 6): the worker's file
// jobs against a real stage database, with an in-memory object store standing
// in for S3 and FileScanResults handed in as a scanner would emit them. Spec
// platform/attachments "Clean file", "Malicious file", "Scan does not finish",
// "Don't send", "Link expires", "Allowed file", "Type not allowed", "Name and
// content disagree", "Logs of an upload" (worker part).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { fileObjectKey, type AttachmentMediaType } from "@a2h/protocol";
import { createPool } from "../src/db.ts";
import { expireDue } from "../src/expire.ts";
import { applyScanResult, checkFile, deleteUnsentFiles, FILE_CHECK_LIMIT_SECONDS, refuseStaleFiles, ScanResultTooEarly, unsentRequestIds, type FilesContext } from "../src/files/jobs.ts";
import { MemoryFileStore } from "../src/files/memory.ts";
import type { WorkerLogLine } from "../src/log.ts";
import { createAwaiting, statusOf } from "./lib/requests.ts";
import { PRINCIPAL_ID, rows, skipWithoutDocker, startStageDb, STAGE, testConfig, type StageDb } from "./lib/stage-db.ts";

const skip = skipWithoutDocker();
const PREFIX = "pr-12/";
/** A name that must never reach a log line. */
const SECRET_NAME = "Diagnostic-de-Mme-Durand.pdf";

const PDF = new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"));
const HTML = new Uint8Array(Buffer.from("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>"));
const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 20, 0, 0, 0, 8, 0, 0, 0]);
// The standard EICAR test string: harmless, recognised by every scanner.
const EICAR = new Uint8Array(Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"));

let fileCounter = 0;
function nextFileId(): string {
  fileCounter += 1;
  return `f${"A".repeat(16)}${fileCounter.toString(36).padStart(6, "0")}`;
}

describe("file jobs (D3, D5)", { skip }, () => {
  let stage: StageDb;
  let pool: pg.Pool;
  let store: MemoryFileStore;
  let logs: WorkerLogLine[] = [];
  const at = (offsetSeconds: number) => () => new Date(Date.now() + offsetSeconds * 1000);
  const ctx = (now = at(0)): FilesContext => ({ pool, config: testConfig(stage.db), log: (l) => logs.push(l), now, store, storagePrefix: PREFIX });

  /** A file as the page records it, and (unless `uploaded: false`) its bytes in tmp/ as the browser posts them. */
  async function addFile(requestId: string, o: { declared: AttachmentMediaType; content: Uint8Array; size?: number; uploaded?: boolean; created_ago?: number }) {
    const id = nextFileId();
    const tmp = fileObjectKey("tmp", PREFIX, requestId, id);
    await stage.admin.query(
      `INSERT INTO request_files (id, request_id, principal_id, name, declared_type, size_bytes, state, object_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'uploading', $7, now() - make_interval(secs => $8))`,
      [id, requestId, PRINCIPAL_ID, SECRET_NAME, o.declared, o.size ?? o.content.length, tmp, o.created_ago ?? 0],
    );
    if (o.uploaded !== false) store.put(tmp, o.content, o.declared);
    return { id, tmp, uploads: fileObjectKey("uploads", PREFIX, requestId, id) };
  }

  const fileRow = async (id: string) =>
    (await rows<{ state: string; refused_reason: string | null; media_type: string | null; object_key: string; deleted_at: Date | null }>(stage.admin, `SELECT state, refused_reason, media_type, object_key, deleted_at FROM request_files WHERE id = $1`, [id]))[0]!;

  before(async () => {
    stage = await startStageDb();
    pool = createPool(stage.db);
  });
  after(async () => {
    await pool?.end();
    await stage?.stop();
  });
  beforeEach(() => {
    store = new MemoryFileStore();
    logs = [];
  });

  test("Scenario: Allowed file: a PDF whose bytes are a PDF moves on to the malware check, its type recorded from the bytes", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "application/pdf", content: PDF });
    assert.equal(await checkFile(ctx(), f.id), "checking");
    assert.deepEqual(await fileRow(f.id), { state: "checking", refused_reason: null, media_type: "application/pdf", object_key: f.tmp, deleted_at: null });
    assert.ok(store.has(f.tmp), "the object stays in tmp/ for the scanner");
    assert.equal(await checkFile(ctx(), f.id), "ignored", "a repeated Object Created event changes nothing");
  });

  test("Scenario: Name and content disagree: a file declared a PDF that contains HTML is refused as a type not allowed and deleted", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "application/pdf", content: HTML });
    assert.equal(await checkFile(ctx(), f.id), "refused");
    const row = await fileRow(f.id);
    assert.equal(row.state, "refused");
    assert.equal(row.refused_reason, "type");
    assert.ok(!store.has(f.tmp), "deleted");
  });

  test("Scenario: Type not allowed: a ZIP archive is refused and deleted; the request's other files are unaffected", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const ok = await addFile(r.id, { declared: "application/pdf", content: PDF });
    const zip = await addFile(r.id, { declared: "text/plain", content: ZIP });
    await checkFile(ctx(), ok.id);
    assert.equal(await checkFile(ctx(), zip.id), "refused");
    assert.equal((await fileRow(zip.id)).refused_reason, "type");
    assert.ok(!store.has(zip.tmp));
    assert.equal((await fileRow(ok.id)).state, "checking");
    assert.ok(store.has(ok.tmp));
  });

  test("a stored object whose size differs from the size recorded at upload is refused (size)", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "application/pdf", content: PDF, size: PDF.length - 1 });
    assert.equal(await checkFile(ctx(), f.id), "refused");
    assert.equal((await fileRow(f.id)).refused_reason, "size");
    assert.ok(!store.has(f.tmp));
  });

  test("Scenario: Clean file: a clean result makes the file ready, copied to uploads/ with its recorded type, tmp/ deleted; repeated results change nothing", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await checkFile(ctx(), f.id);
    assert.equal(await applyScanResult(ctx(), { file_id: f.id, outcome: "clean" }), "ready");
    const row = await fileRow(f.id);
    assert.equal(row.state, "ready");
    assert.equal(row.object_key, f.uploads);
    assert.ok(!store.has(f.tmp), "tmp/ object deleted");
    assert.deepEqual(store.get(f.uploads)?.content_type, "application/pdf");
    // At-least-once delivery: the same result again, then a contradicting one, change nothing.
    assert.equal(await applyScanResult(ctx(), { file_id: f.id, outcome: "clean" }), "ignored");
    assert.equal(await applyScanResult(ctx(), { file_id: f.id, outcome: "threat" }), "ignored");
    assert.equal((await fileRow(f.id)).state, "ready");
    assert.ok(store.has(f.uploads));
  });

  test("Scenario: Malicious file: EICAR named notes.txt is refused by the security check and deleted; nothing names the detection", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "text/plain", content: EICAR });
    assert.equal(await checkFile(ctx(), f.id), "checking", "the EICAR string is printable text: only the scan can refuse it");
    assert.equal(await applyScanResult(ctx(), { file_id: f.id, outcome: "threat" }), "refused");
    const row = await fileRow(f.id);
    assert.equal(row.state, "refused");
    assert.equal(row.refused_reason, "malware");
    assert.ok(!store.has(f.tmp) && !store.has(f.uploads), "deleted from both areas");
    assert.equal(await applyScanResult(ctx(), { file_id: f.id, outcome: "threat" }), "ignored", "a duplicate result changes nothing");
    assert.ok(!JSON.stringify(logs).toLowerCase().includes("eicar"));
  });

  test("a scan error (unsupported, access denied, failed: e.g. a password-protected PDF) refuses the file as not checked", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await checkFile(ctx(), f.id);
    assert.equal(await applyScanResult(ctx(), { file_id: f.id, outcome: "error" }), "refused");
    assert.equal((await fileRow(f.id)).refused_reason, "not_checked");
    assert.ok(!store.has(f.tmp));
  });

  test("a result that overtakes the content check is retried, never applied before it nor lost", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await assert.rejects(applyScanResult(ctx(), { file_id: f.id, outcome: "clean" }), ScanResultTooEarly);
    assert.equal((await fileRow(f.id)).state, "uploading");
    await checkFile(ctx(), f.id);
    assert.equal(await applyScanResult(ctx(), { file_id: f.id, outcome: "clean" }), "ready");
  });

  test("a result for an unknown file, or for a file the principal removed, is ignored", async () => {
    assert.equal(await applyScanResult(ctx(), { file_id: nextFileId(), outcome: "clean" }), "ignored");
    assert.equal(await checkFile(ctx(), nextFileId()), "ignored");
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await checkFile(ctx(), f.id);
    await stage.admin.query(`UPDATE request_files SET deleted_at = now() WHERE id = $1`, [f.id]);
    await store.delete(f.tmp); // the page deletes the object at once (D5)
    assert.equal(await applyScanResult(ctx(), { file_id: f.id, outcome: "clean" }), "ignored");
    assert.ok(!store.has(f.uploads), "no copy is made of a removed file");
  });

  test("Scenario: Scan does not finish: 10 minutes after upload a file still checking (or never uploaded) is refused as not checked and deleted", async () => {
    assert.equal(FILE_CHECK_LIMIT_SECONDS, 600);
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const checking = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await checkFile(ctx(), checking.id);
    const never = await addFile(r.id, { declared: "application/pdf", content: PDF, uploaded: false });
    const ready = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await checkFile(ctx(), ready.id);
    await applyScanResult(ctx(), { file_id: ready.id, outcome: "clean" });
    // Nine minutes: nothing changes.
    await refuseStaleFiles(ctx(at(9 * 60)));
    assert.equal((await fileRow(checking.id)).state, "checking");
    // Past ten minutes: both unfinished files refused, the ready one untouched.
    await refuseStaleFiles(ctx(at(10 * 60 + 1)));
    for (const f of [checking, never]) {
      const row = await fileRow(f.id);
      assert.equal(row.state, "refused", f.id);
      assert.equal(row.refused_reason, "not_checked", f.id);
      assert.ok(!store.has(f.tmp), f.id);
    }
    assert.equal((await fileRow(ready.id)).state, "ready");
    assert.ok(store.has(ready.uploads));
    // A late result now changes nothing.
    assert.equal(await applyScanResult(ctx(), { file_id: checking.id, outcome: "clean" }), "ignored");
    assert.ok(!store.has(checking.uploads));
  });

  test("Scenario: Don't send: both files of a request not sent are deleted and their rows marked deleted", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const a = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await checkFile(ctx(), a.id);
    await applyScanResult(ctx(), { file_id: a.id, outcome: "clean" });
    const b = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await checkFile(ctx(), b.id);
    // Don't send (the page's decideApproval), as the database records it.
    await stage.admin.query(`UPDATE requests SET status = 'not_sent', not_sent_reason = 'declined' WHERE id = $1`, [r.id]);
    assert.ok((await unsentRequestIds(ctx())).includes(r.id));
    assert.equal(await deleteUnsentFiles(ctx(), r.id), 2);
    for (const f of [a, b]) {
      assert.ok(!store.has(f.tmp) && !store.has(f.uploads), f.id);
      assert.ok((await fileRow(f.id)).deleted_at !== null, f.id);
    }
    assert.ok(!(await unsentRequestIds(ctx())).includes(r.id), "nothing left to delete");
    assert.equal(await deleteUnsentFiles(ctx(), r.id), 0, "idempotent");
    // A clean result arriving after Don't send makes no copy.
    assert.equal(await applyScanResult(ctx(), { file_id: b.id, outcome: "clean" }), "ignored");
    assert.ok(!store.has(b.uploads));
  });

  test("a clean result racing Don't send leaves no copy behind", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await checkFile(ctx(), f.id);
    // The request is decided between the worker's read and its mark.
    store.onCopy = async () => {
      await stage.admin.query(`UPDATE requests SET status = 'not_sent', not_sent_reason = 'declined' WHERE id = $1`, [r.id]);
    };
    assert.equal(await applyScanResult(ctx(), { file_id: f.id, outcome: "clean" }), "ignored");
    assert.ok(!store.has(f.uploads), "the copy is removed");
    assert.ok(!store.has(f.tmp));
  });

  test("Scenario: Link expires: the file of a request whose approval link expired unused is deleted", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c", approval_expires_in: 60 });
    const f = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await checkFile(ctx(), f.id);
    await expireDue({ ...ctx(at(61)) });
    assert.equal(await statusOf(stage.admin, r.id), "not_sent");
    for (const id of await unsentRequestIds(ctx())) await deleteUnsentFiles(ctx(), id);
    assert.ok(!store.has(f.tmp));
    assert.ok((await fileRow(f.id)).deleted_at !== null);
  });

  test("a storage failure while deleting leaves the rows live, so the next run deletes them", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await addFile(r.id, { declared: "application/pdf", content: PDF });
    await stage.admin.query(`UPDATE requests SET status = 'not_sent', not_sent_reason = 'declined' WHERE id = $1`, [r.id]);
    store.failDeletes = true;
    await assert.rejects(deleteUnsentFiles(ctx(), r.id));
    assert.equal((await fileRow(f.id)).deleted_at, null);
    store.failDeletes = false;
    assert.equal(await deleteUnsentFiles(ctx(), r.id), 1);
    assert.ok(!store.has(f.tmp));
  });

  test("Scenario: Logs of an upload (worker): no log line carries the file's name or content, only ids, states and codes", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c", approval_expires_in: 60 });
    const a = await addFile(r.id, { declared: "application/pdf", content: PDF });
    const b = await addFile(r.id, { declared: "application/pdf", content: HTML });
    const c = await addFile(r.id, { declared: "text/plain", content: EICAR });
    const d = await addFile(r.id, { declared: "application/pdf", content: PDF });
    logs = [];
    for (const f of [a, b, c, d]) await checkFile(ctx(), f.id);
    await applyScanResult(ctx(), { file_id: a.id, outcome: "clean" });
    await applyScanResult(ctx(), { file_id: c.id, outcome: "threat" });
    await refuseStaleFiles(ctx(at(601)));
    await expireDue({ ...ctx(at(3601)) });
    for (const id of await unsentRequestIds(ctx())) await deleteUnsentFiles(ctx(), id);
    assert.ok(logs.length >= 5, "the jobs do log");
    const text = JSON.stringify(logs);
    for (const forbidden of [SECRET_NAME, "Durand", "%PDF", "<!DOCTYPE", "EICAR", "X5O!P"]) assert.ok(!text.includes(forbidden), forbidden);
    for (const line of logs) assert.equal(line.stage ?? STAGE, STAGE);
    assert.ok(logs.some((l) => l.file_id === a.id && l.state === "ready"));
    assert.ok(logs.some((l) => l.file_id === c.id && l.refused_reason === "malware"));
  });
});
