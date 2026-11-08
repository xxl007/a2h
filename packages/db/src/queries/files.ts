// Files a principal attaches to a request (m2-attachments design D1, D2, D3,
// D5, D6). Shared by apps/web (add, list, remove, read: through the Data API,
// so one statement at a time on a transaction, ADR 0001 amendment 3) and
// apps/worker (the marks and the deletion of unsent files). Every change to a
// file locks its request first, the same lock `decideApproval` takes, so a
// file can never change once the request is sent (D4); migration 0012's
// trigger refuses it at the database as well. Object storage is the caller's:
// these queries return object keys, they never touch S3. File names are
// returned to the page only and must never be logged.
import {
  approvalTokenHash,
  ApprovalTokenSchema,
  ATTACHMENT_MAX_BYTES,
  AttachmentMediaTypeSchema,
  ATTACHMENTS_MAX,
  ATTACHMENTS_MAX_TOTAL_BYTES,
  type AttachmentMediaType,
  type FileRefusedReason,
  FileIdSchema,
  type FileState,
} from "@a2h/protocol";
import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { requestFiles, requests } from "../schema.ts";
import type { A2hDb } from "./mcp.ts";

type RequestRow = typeof requests.$inferSelect;

/** A file as the approval page lists it (the principal's own view: the name is theirs). */
export interface RequestFileView {
  id: string;
  name: string;
  /** What the browser declared at upload; shown until the content check sets `media_type`. */
  declared_type: AttachmentMediaType;
  /** Set by the content check (D3), from the bytes. */
  media_type: AttachmentMediaType | null;
  size_bytes: number;
  state: FileState;
  refused_reason: FileRefusedReason | null;
  created_at: Date;
}

/** The new file's row, before the browser uploads it (D2). */
export interface NewRequestFile {
  /** `formatFileId(16 random bytes)`. */
  id: string;
  /** As the principal's file was named, 1 to 255 characters. Never logged. */
  name: string;
  /** The browser's claim; refused unless it is an allowed type. */
  declared_type: string;
  size_bytes: number;
  /** `tmp/<STORAGE_PREFIX>files/<request_id>/<file_id>`: where the presigned POST puts it. */
  object_key: string;
}

/** The page's checks for any change to a request's files: the link's token, the signed-in principal, the clock. */
export interface FileAccess {
  request_id: string;
  /** The `t` of the approval link, as the page's cookie holds it. */
  token: string;
  principal_id: string;
  now: Date;
}

/**
 * Why a change was refused before anything was looked at: an unknown request
 * or a token the server did not issue (`link_invalid`, shown like an expired
 * link), another account's request, a link past its expiry, or a request no
 * longer awaiting approval (its files are fixed).
 */
export type FileAccessRefusal = { kind: "link_invalid" } | { kind: "wrong_principal" } | { kind: "expired" } | { kind: "not_awaiting" };

/**
 * `added`: the row is `uploading`; the caller now issues the presigned POST.
 * `refused`: nothing was recorded; the page states the limit (`type`: not an
 * allowed type; `size`: over 25 MB (`file`) or over 50 MB with the request's
 * other files (`request`); `count`: 5 files held).
 */
export type AddFileOutcome =
  | { kind: "added"; file: RequestFileView }
  | { kind: "refused"; reason: "type" }
  | { kind: "refused"; reason: "count" }
  | { kind: "refused"; reason: "size"; limit: "file" | "request" }
  | FileAccessRefusal;

export type RemoveFileOutcome = { kind: "removed"; object_key: string } | { kind: "not_found" } | FileAccessRefusal;

const NAME_MAX = 255;

function view(r: typeof requestFiles.$inferSelect): RequestFileView {
  return {
    id: r.id,
    name: r.name,
    declared_type: r.declared_type as AttachmentMediaType,
    media_type: r.media_type as AttachmentMediaType | null,
    size_bytes: r.size_bytes,
    state: r.state as FileState,
    refused_reason: r.refused_reason as FileRefusedReason | null,
    created_at: r.created_at,
  };
}

async function lockRequest(tx: A2hDb, requestId: string): Promise<RequestRow | undefined> {
  const [row] = await tx.select().from(requests).where(eq(requests.id, requestId)).for("update");
  return row;
}

/**
 * Lock the request and run the page's checks in the order `decideApproval`
 * runs them: token, principal, state, expiry. The row, or the refusal.
 */
async function lockForChange(tx: A2hDb, a: FileAccess): Promise<RequestRow | FileAccessRefusal> {
  if (!ApprovalTokenSchema.safeParse(a.token).success) return { kind: "link_invalid" };
  const presented = await approvalTokenHash(a.token);
  const row = await lockRequest(tx, a.request_id);
  if (!row || row.approval_token_hash === null || row.approval_token_hash !== presented) return { kind: "link_invalid" };
  if (row.principal_id !== a.principal_id) return { kind: "wrong_principal" };
  if (row.status !== "awaiting_approval") return { kind: "not_awaiting" };
  if (!row.approval_expires_at || row.approval_expires_at.getTime() <= a.now.getTime()) return { kind: "expired" };
  return row;
}

function isRefusal(x: RequestRow | FileAccessRefusal): x is FileAccessRefusal {
  return "kind" in x;
}

/** The request's live files (not removed), oldest first: what Send would attach, refused ones included. */
async function liveFiles(tx: A2hDb, requestId: string, lock: boolean) {
  const q = tx
    .select()
    .from(requestFiles)
    .where(and(eq(requestFiles.request_id, requestId), isNull(requestFiles.deleted_at)))
    .orderBy(asc(requestFiles.seq));
  return lock ? q.for("update") : q;
}

/**
 * Record a file the principal is about to upload (D2), under the request's
 * lock: after the page's checks, refuse a type that is not allowed, a file
 * over 25 MB, a sixth file, or one that takes the request over 50 MB (refused
 * files count for neither); otherwise insert it `uploading`. Throws a
 * RangeError on a malformed id or a name outside 1..255 characters (the
 * caller's error, not the principal's).
 */
export async function addRequestFile(db: A2hDb, a: FileAccess & { file: NewRequestFile }): Promise<AddFileOutcome> {
  const f = a.file;
  if (!FileIdSchema.safeParse(f.id).success) throw new RangeError("malformed file id");
  if (f.name.length < 1 || f.name.length > NAME_MAX) throw new RangeError("file name outside 1..255 characters");
  if (!Number.isSafeInteger(f.size_bytes) || f.size_bytes < 1) throw new RangeError("file size must be a positive integer");
  return db.transaction(async (tx): Promise<AddFileOutcome> => {
    const row = await lockForChange(tx, a);
    if (isRefusal(row)) return row;
    const declared = AttachmentMediaTypeSchema.safeParse(f.declared_type);
    if (!declared.success) return { kind: "refused", reason: "type" };
    if (f.size_bytes > ATTACHMENT_MAX_BYTES) return { kind: "refused", reason: "size", limit: "file" };
    const held = (await liveFiles(tx, row.id, false)).filter((x) => x.state !== "refused");
    if (held.length >= ATTACHMENTS_MAX) return { kind: "refused", reason: "count" };
    if (held.reduce((sum, x) => sum + x.size_bytes, 0) + f.size_bytes > ATTACHMENTS_MAX_TOTAL_BYTES) return { kind: "refused", reason: "size", limit: "request" };
    const [inserted] = await tx
      .insert(requestFiles)
      .values({
        id: f.id,
        request_id: row.id,
        principal_id: row.principal_id,
        name: f.name,
        declared_type: declared.data,
        size_bytes: f.size_bytes,
        state: "uploading",
        object_key: f.object_key,
        created_at: a.now,
      })
      .returning();
    return { kind: "added", file: view(inserted!) };
  });
}

/**
 * The request's files as the page lists them, oldest first; removed files
 * are not listed. The caller has already checked the link and the principal
 * (as the page does before showing anything).
 */
export async function listRequestFiles(db: A2hDb, requestId: string): Promise<RequestFileView[]> {
  return (await liveFiles(db, requestId, false)).map(view);
}

/**
 * Remove a file before Send (D5): under the request's lock, mark it deleted
 * and return its current object key, which the caller deletes at once.
 */
export async function removeRequestFile(db: A2hDb, a: FileAccess & { file_id: string }): Promise<RemoveFileOutcome> {
  return db.transaction(async (tx): Promise<RemoveFileOutcome> => {
    const row = await lockForChange(tx, a);
    if (isRefusal(row)) return row;
    const [removed] = await tx
      .update(requestFiles)
      .set({ deleted_at: a.now })
      .where(and(eq(requestFiles.id, a.file_id), eq(requestFiles.request_id, row.id), isNull(requestFiles.deleted_at)))
      .returning({ object_key: requestFiles.object_key });
    return removed ? { kind: "removed", object_key: removed.object_key } : { kind: "not_found" };
  });
}

/**
 * What the page needs to issue a short-lived download link (D6): the object
 * key and recorded type of a ready file of the principal's request, awaiting
 * approval with a live link, or sent. Anything else (another account, a
 * forged token, a file not ready, removed or unknown, a request not sent) is
 * `null`, which reveals nothing (spec "Another account").
 */
export async function fileForReading(db: A2hDb, a: FileAccess & { file_id: string }): Promise<{ object_key: string; media_type: AttachmentMediaType } | null> {
  if (!ApprovalTokenSchema.safeParse(a.token).success) return null;
  const presented = await approvalTokenHash(a.token);
  const [found] = await db
    .select({
      object_key: requestFiles.object_key,
      media_type: requestFiles.media_type,
      state: requestFiles.state,
      principal_id: requests.principal_id,
      token_hash: requests.approval_token_hash,
      status: requests.status,
      approval_expires_at: requests.approval_expires_at,
    })
    .from(requestFiles)
    .innerJoin(requests, eq(requests.id, requestFiles.request_id))
    .where(and(eq(requestFiles.id, a.file_id), eq(requestFiles.request_id, a.request_id), isNull(requestFiles.deleted_at)));
  if (!found || found.token_hash === null || found.token_hash !== presented || found.principal_id !== a.principal_id) return null;
  if (found.state !== "ready" || found.media_type === null) return null;
  if (found.status === "not_sent") return null;
  if (found.status === "awaiting_approval" && (!found.approval_expires_at || found.approval_expires_at.getTime() <= a.now.getTime())) return null;
  return { object_key: found.object_key, media_type: found.media_type as AttachmentMediaType };
}

// ---- the worker's marks (D3) -------------------------------------------------

/**
 * Run `change` on a live file of a request awaiting approval, under the
 * request's lock (so it is serialised with Send and Don't send); false (or
 * null) when the file is gone or its request is decided.
 */
async function onAwaitingFile<T>(db: A2hDb, fileId: string, change: (tx: A2hDb) => Promise<T>, none: T): Promise<T> {
  return db.transaction(async (tx) => {
    const [f] = await tx.select({ request_id: requestFiles.request_id }).from(requestFiles).where(and(eq(requestFiles.id, fileId), isNull(requestFiles.deleted_at)));
    if (!f) return none;
    const row = await lockRequest(tx, f.request_id);
    if (row?.status !== "awaiting_approval") return none;
    return change(tx);
  });
}

/** The content check passed (D3): `uploading` → `checking`, with the type read from the bytes. True if it changed. */
export async function markFileChecking(db: A2hDb, fileId: string, mediaType: string): Promise<boolean> {
  const type = AttachmentMediaTypeSchema.safeParse(mediaType);
  if (!type.success) throw new RangeError("not an allowed media type");
  return onAwaitingFile(
    db,
    fileId,
    async (tx) =>
      (await tx.update(requestFiles).set({ state: "checking", media_type: type.data }).where(and(eq(requestFiles.id, fileId), eq(requestFiles.state, "uploading"))).returning({ id: requestFiles.id })).length === 1,
    false,
  );
}

/**
 * The scan found nothing (D3): `checking` → `ready`, at the object's new key
 * in the uploads area. True if it changed; a duplicate result changes nothing.
 */
export async function markFileReady(db: A2hDb, fileId: string, objectKey: string, now: Date): Promise<boolean> {
  return onAwaitingFile(
    db,
    fileId,
    async (tx) =>
      (await tx.update(requestFiles).set({ state: "ready", object_key: objectKey, ready_at: now }).where(and(eq(requestFiles.id, fileId), eq(requestFiles.state, "checking"))).returning({ id: requestFiles.id })).length === 1,
    false,
  );
}

/**
 * Refuse a file still `uploading` or `checking` (type, malware, not checked
 * in time, upload failed). Returns its object key for the caller to delete,
 * or null if nothing changed (already ready or refused, removed, or its
 * request decided).
 */
export async function refuseFile(db: A2hDb, fileId: string, reason: FileRefusedReason): Promise<{ object_key: string } | null> {
  return onAwaitingFile(
    db,
    fileId,
    async (tx) => {
      const [r] = await tx
        .update(requestFiles)
        .set({ state: "refused", refused_reason: reason })
        .where(and(eq(requestFiles.id, fileId), inArray(requestFiles.state, ["uploading", "checking"])))
        .returning({ object_key: requestFiles.object_key });
      return r ?? null;
    },
    null,
  );
}

/**
 * The files of a request that was not sent (Don't send, link expired; D5):
 * mark every live file deleted and return their object keys for the caller
 * to delete. A request in any other status is left alone ([]).
 */
export async function deleteUnsentRequestFiles(db: A2hDb, requestId: string, now: Date): Promise<string[]> {
  return db.transaction(async (tx) => {
    const row = await lockRequest(tx, requestId);
    if (row?.status !== "not_sent") return [];
    const gone = await tx
      .update(requestFiles)
      .set({ deleted_at: now })
      .where(and(eq(requestFiles.request_id, requestId), isNull(requestFiles.deleted_at)))
      .returning({ object_key: requestFiles.object_key });
    return gone.map((g) => g.object_key);
  });
}

// ---- what the worker reads (D3, D5; m2-attachments task 3.2) -----------------

/** A file as the worker's jobs see it: never its name. */
export interface WorkerFileView {
  id: string;
  request_id: string;
  declared_type: AttachmentMediaType;
  media_type: AttachmentMediaType | null;
  size_bytes: number;
  state: FileState;
  removed: boolean;
  request_status: string;
}

/** One file by id for the worker (no name), with its request's status; null if unknown. */
export async function fileForWorker(db: A2hDb, fileId: string): Promise<WorkerFileView | null> {
  const [r] = await db
    .select({
      id: requestFiles.id,
      request_id: requestFiles.request_id,
      declared_type: requestFiles.declared_type,
      media_type: requestFiles.media_type,
      size_bytes: requestFiles.size_bytes,
      state: requestFiles.state,
      deleted_at: requestFiles.deleted_at,
      request_status: requests.status,
    })
    .from(requestFiles)
    .innerJoin(requests, eq(requests.id, requestFiles.request_id))
    .where(eq(requestFiles.id, fileId));
  if (!r) return null;
  return {
    id: r.id,
    request_id: r.request_id,
    declared_type: r.declared_type as AttachmentMediaType,
    media_type: r.media_type as AttachmentMediaType | null,
    size_bytes: r.size_bytes,
    state: r.state as FileState,
    removed: r.deleted_at !== null,
    request_status: r.request_status,
  };
}

/**
 * Live files still `uploading` or `checking` that were recorded at or before
 * `createdBefore`, on requests still awaiting approval: the ones the
 * 10-minute limit refuses as not checked (D3). Oldest first.
 */
export async function staleFiles(db: A2hDb, createdBefore: Date, limit: number): Promise<{ id: string; request_id: string }[]> {
  return db
    .select({ id: requestFiles.id, request_id: requestFiles.request_id })
    .from(requestFiles)
    .innerJoin(requests, eq(requests.id, requestFiles.request_id))
    .where(
      and(
        isNull(requestFiles.deleted_at),
        inArray(requestFiles.state, ["uploading", "checking"]),
        lte(requestFiles.created_at, createdBefore),
        eq(requests.status, "awaiting_approval"),
      ),
    )
    .orderBy(asc(requestFiles.created_at))
    .limit(limit);
}

/** Requests that were not sent and still have live files (D5): the `files-delete` job's work. */
export async function unsentRequestsWithFiles(db: A2hDb, limit: number): Promise<string[]> {
  const found = await db
    .selectDistinct({ request_id: requestFiles.request_id })
    .from(requestFiles)
    .innerJoin(requests, eq(requests.id, requestFiles.request_id))
    .where(and(isNull(requestFiles.deleted_at), eq(requests.status, "not_sent")))
    .limit(limit);
  return found.map((r) => r.request_id);
}

/** The live files of a request that was not sent (ids only); [] for a request in any other status. */
export async function unsentRequestFiles(db: A2hDb, requestId: string): Promise<string[]> {
  const found = await db
    .select({ id: requestFiles.id })
    .from(requestFiles)
    .innerJoin(requests, eq(requests.id, requestFiles.request_id))
    .where(and(eq(requestFiles.request_id, requestId), isNull(requestFiles.deleted_at), eq(requests.status, "not_sent")));
  return found.map((r) => r.id);
}

// ---- Send (D4) ---------------------------------------------------------------

/**
 * Under the request's lock (taken by `decideApproval`): the request's live
 * files, locked, oldest first. `not_ready` if any is not `ready` (uploading,
 * checking, or refused and still listed); otherwise the manifest's
 * attachments (ref, type, size), or none.
 */
export async function attachmentsForSend(
  tx: A2hDb,
  requestId: string,
): Promise<{ ready: false } | { ready: true; attachments: { ref: string; media_type: AttachmentMediaType; size_bytes: number }[] }> {
  const files = await liveFiles(tx, requestId, true);
  if (files.some((f) => f.state !== "ready" || f.media_type === null)) return { ready: false };
  return { ready: true, attachments: files.map((f) => ({ ref: f.id, media_type: f.media_type as AttachmentMediaType, size_bytes: f.size_bytes })) };
}
