// m2-attachments task 3.2, wired: the running worker takes file events from a
// FileEventSource (here the in-memory one, standing in for the SQS queue that
// carries S3 and GuardDuty events on a deployed stage) and runs `file-check`,
// `file-scan`, `files-sweep` and `files-delete` through pg-boss. This is the
// path a local run exercises without AWS: emit "created", then a scan result.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileObjectKey } from "@a2h/protocol";
import { etagOf, MemoryFileEvents, MemoryFileStore } from "../src/files/memory.ts";
import type { WorkerLogLine } from "../src/log.ts";
import { startWorker, type RunningWorker } from "../src/worker.ts";
import { createAwaiting } from "./lib/requests.ts";
import { JOBS_SCHEMA, PRINCIPAL_ID, rows, skipWithoutDocker, startStageDb, testConfig, testSigningKey, type StageDb } from "./lib/stage-db.ts";

const skip = skipWithoutDocker();
const PREFIX = "pr-12/";
const PDF = new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"));

async function until<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe("the running worker's file path", { skip }, () => {
  let stage: StageDb;
  let worker: RunningWorker | undefined;
  const store = new MemoryFileStore();
  const events = new MemoryFileEvents();
  const logs: WorkerLogLine[] = [];
  let n = 0;

  async function upload(requestId: string) {
    n += 1;
    const id = `fRUN${"0".repeat(13)}${n.toString().padStart(6, "0")}`;
    const tmp = fileObjectKey("tmp", PREFIX, requestId, id);
    await stage.admin.query(
      `INSERT INTO request_files (id, request_id, principal_id, name, declared_type, size_bytes, state, object_key) VALUES ($1, $2, $3, 'secret-name.pdf', 'application/pdf', $4, 'uploading', $5)`,
      [id, requestId, PRINCIPAL_ID, PDF.length, tmp],
    );
    store.put(tmp, PDF, "application/pdf");
    return { id, tmp, uploads: fileObjectKey("uploads", PREFIX, requestId, id) };
  }
  const stateOf = async (id: string) => (await rows<{ state: string; deleted_at: Date | null }>(stage.admin, `SELECT state, deleted_at FROM request_files WHERE id = $1`, [id]))[0];

  before(async () => {
    stage = await startStageDb();
    worker = await startWorker({
      config: testConfig(stage.db, { signing: testSigningKey("a2h-pr-12-files0000000001") }),
      log: (l) => logs.push(l),
      pollingIntervalSeconds: 0.5,
      files: { store, events, storagePrefix: PREFIX, scanRetryDelaySeconds: 1 },
    });
  });
  after(async () => {
    await worker?.stop();
    await stage?.stop();
  });

  test("created then clean: the file becomes ready through the queues", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await upload(r.id);
    await events.emit({ kind: "created", file_id: f.id });
    await until("checking", async () => (await stateOf(f.id))?.state === "checking");
    await events.emit({ kind: "scanned", result: { file_id: f.id, outcome: "clean", etag: etagOf(PDF) } });
    await until("ready", async () => (await stateOf(f.id))?.state === "ready");
    assert.ok(store.has(f.uploads) && !store.has(f.tmp));
  });

  test("a scan result that arrives before the object-created event is retried and applied after the check", async () => {
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await upload(r.id);
    await events.emit({ kind: "scanned", result: { file_id: f.id, outcome: "clean", etag: etagOf(PDF) } });
    await sleep(300);
    await events.emit({ kind: "created", file_id: f.id });
    await until("ready after the retry", async () => (await stateOf(f.id))?.state === "ready");
  });

  test("files-sweep is scheduled every minute; Don't send leads to files-delete", async () => {
    const schedules = (await rows<{ name: string; cron: string }>(stage.admin, `SELECT name, cron FROM ${JOBS_SCHEMA}.schedule ORDER BY name`)).map((s) => `${s.name} ${s.cron}`);
    assert.deepEqual(schedules, ["expire * * * * *", "files-sweep * * * * *"]);
    const r = await createAwaiting(stage.admin, { handle: "sim-mv-7f3c" });
    const f = await upload(r.id);
    await stage.admin.query(`UPDATE requests SET status = 'not_sent', not_sent_reason = 'declined' WHERE id = $1`, [r.id]);
    // Run the sweep now rather than waiting for the minute.
    await worker!.runFilesSweep();
    await until("deleted", async () => (await stateOf(f.id))?.deleted_at != null);
    assert.ok(!store.has(f.tmp));
  });

  test("no log line names a file", () => {
    assert.ok(logs.length > 0);
    assert.ok(!JSON.stringify(logs).includes("secret-name"));
  });
});
