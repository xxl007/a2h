// The worker's file jobs (m2-attachments design D3, D5; ADR 0005 item 6).
// - checkFile (`file-check`): read the first 8 KB of an uploaded object,
//   identify its type from the bytes, mark it `checking` or refuse it (type,
//   size) and delete it.
// - applyScanResult (`file-scan`): a provider-neutral FileScanResult. clean →
//   copy to uploads/ with the recorded type, mark `ready`, delete tmp/;
//   threat → delete, refuse (malware); error → delete, refuse (not_checked).
// - refuseStaleFiles (`files-sweep`): anything not ready 10 minutes after it
//   was recorded is refused as not checked and deleted.
// - deleteUnsentFiles (`files-delete`): the files of a request not sent
//   (Don't send, link expired) are deleted, objects first, rows after.
// Idempotent and monotonic: results arrive at least once and race the
// 10-minute limit; a mark applies only from the state it expects (the
// queries in @a2h/db check it under the request's lock).
//
// Exact bytes (review B1): the presigned POST can be used more than once
// within its 5 minutes, so the object in tmp/ can change after it was
// checked. The check records the ETag of the object it read; a clean verdict
// applies only to that ETag, the copy to uploads/ is pinned to it
// (CopySourceIfMatch), and an object seen in tmp/ with another ETag refuses
// the file as not checked. So a file is ready only if the bytes the check
// read are the bytes scanned clean and the bytes copied.
//
// A refusal is recorded (under the request's lock) before any object is
// deleted (review S1): deleting first let a clean result land in between and
// leave a ready row without its object. tmp/ objects are deleted whatever
// happened (no ready row ever points at tmp/); uploads/ only when the refusal
// applied. Logs carry ids, states, types, sizes and codes: never a file's
// name, its bytes or its ETag.
import { fileForWorker, markFileChecking, markFileReady, refuseFile, staleFiles, unsentRequestFiles, unsentRequestsWithFiles, deleteUnsentRequestFiles, type WorkerFileView } from "@a2h/db";
import { fileObjectKey, type FileRefusedReason, type FileScanResult } from "@a2h/protocol";
import type { JobContext } from "../context.ts";
import { dbOf } from "../db.ts";
import { SNIFF_BYTES, sniffFile } from "./sniff.ts";
import type { FileStore } from "./store.ts";

/** A file not ready this long after it was recorded is refused as not checked (D3). */
export const FILE_CHECK_LIMIT_SECONDS = 600;
const BATCH = 200;

export interface FilesContext extends JobContext {
  store: FileStore;
  /** The stage's STORAGE_PREFIX (`dev/`, `pr-<n>/`, `prod/`). */
  storagePrefix: string;
}

/** A scan result for a file still `uploading`: thrown so that pg-boss retries the job after the content check. */
export class ScanResultTooEarly extends Error {
  constructor() {
    super("scan result before the content check");
    this.name = "ScanResultTooEarly";
  }
}

function keysOf(ctx: FilesContext, f: { request_id: string; id: string }) {
  return { tmp: fileObjectKey("tmp", ctx.storagePrefix, f.request_id, f.id), uploads: fileObjectKey("uploads", ctx.storagePrefix, f.request_id, f.id) };
}

async function deleteBoth(ctx: FilesContext, f: { request_id: string; id: string }): Promise<void> {
  const k = keysOf(ctx, f);
  await ctx.store.delete(k.tmp);
  await ctx.store.delete(k.uploads);
}

/**
 * Record the refusal, then delete the file's objects (S1). "refused" if the
 * refusal applied, else "ignored". tmp/ is deleted either way (a retry after
 * a failed delete finishes the work); uploads/ only when the refusal applied,
 * since a file that became ready meanwhile keeps its copy.
 */
async function refuse(ctx: FilesContext, f: WorkerFileView, reason: FileRefusedReason): Promise<"refused" | "ignored"> {
  const changed = await refuseFile(dbOf(ctx.pool), f.id, reason);
  const k = keysOf(ctx, f);
  await ctx.store.delete(k.tmp);
  if (!changed) return "ignored";
  await ctx.store.delete(k.uploads);
  ctx.log({ level: "info", msg: "file refused", file_id: f.id, request_id: f.request_id, state: "refused", refused_reason: reason });
  return "refused";
}

/**
 * `file-check`: the content check of an uploaded object (D3), run on every
 * Object Created event. For a file still `uploading`: the stored size must be
 * the declared size, the bytes an allowed type matching the declared one;
 * then `checking`, with the ETag read. For a file already `checking`: an
 * object with another ETag than the one checked was posted since, and the
 * file is refused as not checked (B1). For a file ready, refused or removed:
 * an object in tmp/ is a stray re-post and is deleted.
 */
export async function checkFile(ctx: FilesContext, fileId: string, retried = false): Promise<"checking" | "refused" | "ignored"> {
  const f = await fileForWorker(dbOf(ctx.pool), fileId);
  if (!f) return "ignored";
  const k = keysOf(ctx, f);
  if (f.removed || f.state === "ready" || f.state === "refused") {
    await ctx.store.delete(k.tmp);
    return "ignored";
  }
  if (f.request_status !== "awaiting_approval") return "ignored";
  const head = await ctx.store.head(k.tmp, SNIFF_BYTES);
  // No object (yet, or no longer: a clean copy is being made): the 10-minute limit refuses the file if it never arrives.
  if (!head) return "ignored";
  if (f.state === "checking") {
    if (head.etag === f.checked_etag) return "ignored"; // the same object: a repeated event
    return refuse(ctx, f, "not_checked");
  }
  if (head.size !== f.size_bytes) return refuse(ctx, f, "size");
  const sniffed = sniffFile(head.bytes, f.declared_type, { truncated: head.size > head.bytes.length });
  if (!sniffed.ok) return refuse(ctx, f, "type");
  if (!(await markFileChecking(dbOf(ctx.pool), f.id, sniffed.media_type, head.etag))) {
    // Another check marked it first, perhaps on other bytes: compare once with what it recorded.
    return retried ? "ignored" : checkFile(ctx, fileId, true);
  }
  ctx.log({ level: "info", msg: "file type checked", file_id: f.id, request_id: f.request_id, state: "checking", media_type: sniffed.media_type, size_bytes: head.size });
  return "checking";
}

/**
 * `file-scan`: apply one scan result (ADR 0005 item 6). A threat or an error
 * refuses the file whatever bytes it names (fail closed). A clean result
 * makes the file ready only if it names the object the content check read
 * (B1), and the copy is pinned to that object: if tmp/ holds other bytes by
 * then, the file is refused as not checked.
 */
export async function applyScanResult(ctx: FilesContext, result: FileScanResult): Promise<"ready" | "refused" | "ignored"> {
  const f = await fileForWorker(dbOf(ctx.pool), result.file_id);
  if (!f) return "ignored";
  const k = keysOf(ctx, f);
  if (f.removed || f.state === "refused") {
    // Nothing points at either object: finish any cleanup a failed run left.
    await deleteBoth(ctx, f);
    return "ignored";
  }
  if (f.state === "ready") {
    await ctx.store.delete(k.tmp);
    return "ignored";
  }
  if (f.state === "uploading" && f.request_status === "awaiting_approval") throw new ScanResultTooEarly();
  if (f.state !== "checking" || f.request_status !== "awaiting_approval") return "ignored";
  if (result.outcome === "threat") return refuse(ctx, f, "malware");
  if (result.outcome === "error") return refuse(ctx, f, "not_checked");
  const checked = f.checked_etag;
  if (checked === null || result.etag !== checked) return refuse(ctx, f, "not_checked");
  if ((await ctx.store.copy(k.tmp, k.uploads, f.media_type ?? f.declared_type, checked)) === "changed") return refuse(ctx, f, "not_checked");
  if (!(await markFileReady(dbOf(ctx.pool), f.id, k.uploads, ctx.now(), checked))) {
    // Decided, removed or refused meanwhile: no copy may outlive the row.
    await deleteBoth(ctx, f);
    return "ignored";
  }
  await ctx.store.delete(k.tmp);
  ctx.log({ level: "info", msg: "file ready", file_id: f.id, request_id: f.request_id, state: "ready" });
  return "ready";
}

/** `files-sweep`: refuse every file not ready FILE_CHECK_LIMIT_SECONDS after it was recorded. Returns how many. */
export async function refuseStaleFiles(ctx: FilesContext): Promise<number> {
  const before = new Date(ctx.now().getTime() - FILE_CHECK_LIMIT_SECONDS * 1000);
  let refused = 0;
  for (const { id } of await staleFiles(dbOf(ctx.pool), before, BATCH)) {
    const f = await fileForWorker(dbOf(ctx.pool), id);
    if (f && (await refuse(ctx, f, "not_checked")) === "refused") refused += 1;
  }
  return refused;
}

/** Requests not sent that still have live files: one `files-delete` job each. */
export async function unsentRequestIds(ctx: FilesContext): Promise<string[]> {
  return unsentRequestsWithFiles(dbOf(ctx.pool), BATCH);
}

/** `files-delete`: delete the objects of a request not sent, then mark its rows deleted. Returns how many files. */
export async function deleteUnsentFiles(ctx: FilesContext, requestId: string): Promise<number> {
  const ids = await unsentRequestFiles(dbOf(ctx.pool), requestId);
  for (const id of ids) await deleteBoth(ctx, { request_id: requestId, id });
  if (ids.length === 0) return 0;
  const gone = await deleteUnsentRequestFiles(dbOf(ctx.pool), requestId, ctx.now());
  ctx.log({ level: "info", msg: "unsent files deleted", request_id: requestId, count: gone.length });
  return gone.length;
}
