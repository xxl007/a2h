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
// queries in @a2h/db check it under the request's lock). Objects are deleted
// before a refusal is recorded, so a failure leaves work for a retry rather
// than an orphan. Logs carry ids, states, types, sizes and codes: never a
// file's name or any of its bytes.
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

/** Delete the file's objects, then record the refusal. "refused" if the refusal applied, else "ignored". */
async function refuse(ctx: FilesContext, f: WorkerFileView, reason: FileRefusedReason): Promise<"refused" | "ignored"> {
  await deleteBoth(ctx, f);
  const changed = await refuseFile(dbOf(ctx.pool), f.id, reason);
  if (!changed) return "ignored";
  ctx.log({ level: "info", msg: "file refused", file_id: f.id, request_id: f.request_id, state: "refused", refused_reason: reason });
  return "refused";
}

/** `file-check`: the content check of an uploaded object (D3). */
export async function checkFile(ctx: FilesContext, fileId: string): Promise<"checking" | "refused" | "ignored"> {
  const f = await fileForWorker(dbOf(ctx.pool), fileId);
  if (!f || f.removed || f.state !== "uploading" || f.request_status !== "awaiting_approval") return "ignored";
  const head = await ctx.store.head(keysOf(ctx, f).tmp, SNIFF_BYTES);
  // No object (yet): the 10-minute limit refuses the file if it never arrives.
  if (!head) return "ignored";
  if (head.size !== f.size_bytes) return refuse(ctx, f, "size");
  const sniffed = sniffFile(head.bytes, f.declared_type, { truncated: head.size > head.bytes.length });
  if (!sniffed.ok) return refuse(ctx, f, "type");
  if (!(await markFileChecking(dbOf(ctx.pool), f.id, sniffed.media_type))) return "ignored";
  ctx.log({ level: "info", msg: "file type checked", file_id: f.id, request_id: f.request_id, state: "checking", media_type: sniffed.media_type, size_bytes: head.size });
  return "checking";
}

/** `file-scan`: apply one scan result (ADR 0005 item 6). */
export async function applyScanResult(ctx: FilesContext, result: FileScanResult): Promise<"ready" | "refused" | "ignored"> {
  const f = await fileForWorker(dbOf(ctx.pool), result.file_id);
  if (!f || f.removed) return "ignored";
  if (f.state === "uploading" && f.request_status === "awaiting_approval") throw new ScanResultTooEarly();
  if (f.state !== "checking" || f.request_status !== "awaiting_approval") return "ignored";
  if (result.outcome === "threat") return refuse(ctx, f, "malware");
  if (result.outcome === "error") return refuse(ctx, f, "not_checked");
  const k = keysOf(ctx, f);
  await ctx.store.copy(k.tmp, k.uploads, f.media_type ?? f.declared_type);
  if (!(await markFileReady(dbOf(ctx.pool), f.id, k.uploads, ctx.now()))) {
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
