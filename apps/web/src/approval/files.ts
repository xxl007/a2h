// Files on the approval page, server side (m2-attachments task 5.1; design
// D2, D5, D6; spec platform/attachments, platform/approval-page). Each
// function runs after the page's own session check (the action's) with the
// page's token and the session's principal, and calls one packages/db query,
// which checks the token, the principal, the state and the link's expiry
// under the request's lock. Storage is the `FileStore` port
// (apps/web/infra/files.ts); nothing here imports an AWS SDK.
//
// Logs carry the request id, the principal id, the opaque file id and a
// code; never a file's name, its declared type as the browser gave it, a
// key, a link or the token (spec "Logs of an upload").
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENTS_MAX,
  ATTACHMENTS_MAX_TOTAL_BYTES,
  approvalTokenHash,
  ApprovalTokenSchema,
  FileIdSchema,
  formatFileId,
} from "@a2h/protocol";
import {
  addRequestFile,
  eq,
  fileForReading,
  listRequestFiles,
  refuseFile,
  removeRequestFile,
  requests,
  type A2hDb,
  type RequestFileView,
} from "@a2h/db";
import type { ApprovalFile, ApprovalFileRules } from "@a2h/ui";
import * as z from "zod";
import type { FileStore, PresignedUpload } from "../../infra/files";
import { errorFields, type Logger } from "../log";

/** Upload policies and download links work this long (D2, D6). */
export const FILE_LINK_SECONDS = 300;

/** The limits and types the page states (packages/protocol constants), in display order. */
export const FILE_RULES: ApprovalFileRules = {
  accept: ATTACHMENT_MEDIA_TYPES,
  maxFiles: ATTACHMENTS_MAX,
  maxFileBytes: ATTACHMENT_MAX_BYTES,
  maxTotalBytes: ATTACHMENTS_MAX_TOTAL_BYTES,
};

const NAME_MAX = 255;

export interface FilesDeps {
  db: A2hDb;
  store: FileStore;
  logger: Logger;
  /** `dev/`, `pr-<n>/`, `prod/` (STORAGE_PREFIX). */
  storagePrefix: string;
  now?: () => Date;
  /** 16 random bytes for a file id. */
  random?: () => Uint8Array;
}

/** Who asks: the page's token (its cookie) and the session's principal. */
export interface FilesCaller {
  requestId: string;
  token: string | undefined;
  principalId: string;
}

/** What the browser says about a file it is about to upload. Untrusted. */
export const NewFileSchema = z.strictObject({
  name: z.string().max(4096),
  type: z.string().max(255),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type NewFile = z.infer<typeof NewFileSchema>;

/**
 * `added`: the row exists (`uploading`) and the browser posts the file with
 * `upload`. `refused`: nothing was stored; the reason the page states
 * (`size` the file, `total` the request with it). `unavailable`: the link
 * expired, the account is not the request's, the request was decided, or
 * the call failed; the page keeps the file as an unfinished upload.
 */
export type AddFileResult =
  | { kind: "added"; file: ApprovalFile; upload: PresignedUpload }
  | { kind: "refused"; refusal: "type" | "size" | "total" | "count" }
  | { kind: "unavailable" };

export type RemoveFileResult = { kind: "removed" } | { kind: "unavailable" };
export type OpenFileResult = { url: string } | { url: null };
export type FilesResult = { kind: "files"; files: ApprovalFile[] } | { kind: "unavailable" };

/** `tmp/<prefix>files/<request id>/<file id>`: where the presigned POST puts a file (D2). */
export function uploadKey(storagePrefix: string, requestId: string, fileId: string): string {
  return `tmp/${storagePrefix}files/${requestId}/${fileId}`;
}

/** D6: images open in the tab; PDF, text, CSV and Markdown download. */
export function dispositionFor(mediaType: string): "inline" | "attachment" {
  return mediaType.startsWith("image/") ? "inline" : "attachment";
}

/** At most 255 UTF-16 units without cutting a character in half; an empty name gets one. */
export function storedName(name: string): string {
  let out = "";
  for (const ch of name) {
    if (out.length + ch.length > NAME_MAX) break;
    out += ch;
  }
  return out.trim() === "" ? "file" : out;
}

/** A row as the page shows it (design.md F0 `ApprovalFile`). */
export function approvalFileOf(r: RequestFileView): ApprovalFile {
  return {
    id: r.id,
    name: r.name,
    mediaType: r.media_type ?? r.declared_type,
    sizeBytes: r.size_bytes,
    state: r.state,
    ...(r.state === "refused" && r.refused_reason !== null ? { refusal: r.refused_reason } : {}),
  };
}

function randomBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export async function addFile(deps: FilesDeps, c: FilesCaller, input: unknown): Promise<AddFileResult> {
  const fields = { request_id: c.requestId, principal_id: c.principalId };
  const parsed = NewFileSchema.safeParse(input);
  if (!parsed.success) {
    deps.logger.warn("file add refused: malformed input", { ...fields, code: "file_add_malformed" });
    return { kind: "unavailable" };
  }
  if (c.token === undefined) return { kind: "unavailable" };
  const f = parsed.data;
  // An empty file is no allowed type (nothing to identify); the database refuses size 0.
  if (f.size === 0) {
    deps.logger.info("file refused before storing", { ...fields, code: "file_refused_type" });
    return { kind: "refused", refusal: "type" };
  }
  const id = formatFileId((deps.random ?? randomBytes)());
  try {
    const outcome = await addRequestFile(deps.db, {
      request_id: c.requestId,
      token: c.token,
      principal_id: c.principalId,
      now: deps.now?.() ?? new Date(),
      file: { id, name: storedName(f.name), declared_type: f.type, size_bytes: f.size, object_key: uploadKey(deps.storagePrefix, c.requestId, id) },
    });
    switch (outcome.kind) {
      case "added": {
        const upload = await deps.store.presignUpload({
          key: uploadKey(deps.storagePrefix, c.requestId, id),
          contentType: outcome.file.declared_type,
          // Exactly the declared size: the stored object is the one the limits were checked against (review B1).
          sizeBytes: outcome.file.size_bytes,
          expiresSeconds: FILE_LINK_SECONDS,
        });
        deps.logger.info("file added", { ...fields, file_id: id, code: "file_added" });
        return { kind: "added", file: approvalFileOf(outcome.file), upload };
      }
      case "refused": {
        const refusal = outcome.reason === "size" && outcome.limit === "request" ? "total" : outcome.reason;
        deps.logger.info("file refused before storing", { ...fields, code: `file_refused_${refusal}` });
        return { kind: "refused", refusal };
      }
      default:
        deps.logger.info("file add refused", { ...fields, code: `file_add_${outcome.kind}` });
        return { kind: "unavailable" };
    }
  } catch (e) {
    deps.logger.error("file add failed", { ...fields, file_id: id, ...errorFields(e) });
    return { kind: "unavailable" };
  }
}

export async function removeFile(deps: FilesDeps, c: FilesCaller, fileId: unknown): Promise<RemoveFileResult> {
  const fields = { request_id: c.requestId, principal_id: c.principalId };
  if (c.token === undefined || !FileIdSchema.safeParse(fileId).success) return { kind: "unavailable" };
  const id = fileId as string;
  try {
    const outcome = await removeRequestFile(deps.db, { request_id: c.requestId, token: c.token, principal_id: c.principalId, now: deps.now?.() ?? new Date(), file_id: id });
    if (outcome.kind === "not_found") {
      // Already gone (removed in another tab, or never stored): the page's wish holds.
      deps.logger.info("file remove: nothing to remove", { ...fields, file_id: id, code: "file_remove_not_found" });
      return { kind: "removed" };
    }
    if (outcome.kind !== "removed") {
      deps.logger.info("file remove refused", { ...fields, file_id: id, code: `file_remove_${outcome.kind}` });
      return { kind: "unavailable" };
    }
    deps.logger.info("file removed", { ...fields, file_id: id, code: "file_removed" });
    // D5: the object goes at once. The row is already marked; a failed delete is left to the area's lifecycle rule.
    try {
      await deps.store.deleteObject(outcome.object_key);
    } catch (e) {
      deps.logger.warn("file object not deleted", { ...fields, file_id: id, ...errorFields(e), code: "file_object_delete_failed" });
    }
    return { kind: "removed" };
  } catch (e) {
    deps.logger.error("file remove failed", { ...fields, file_id: id, ...errorFields(e) });
    return { kind: "unavailable" };
  }
}

/** D6: a 5-minute link to a ready file of the caller's request; null reveals nothing (spec "Another account"). */
export async function openFile(deps: FilesDeps, c: FilesCaller, fileId: unknown): Promise<OpenFileResult> {
  const fields = { request_id: c.requestId, principal_id: c.principalId };
  if (c.token === undefined || !FileIdSchema.safeParse(fileId).success) return { url: null };
  const id = fileId as string;
  try {
    const found = await fileForReading(deps.db, { request_id: c.requestId, token: c.token, principal_id: c.principalId, now: deps.now?.() ?? new Date(), file_id: id });
    if (found === null) {
      deps.logger.info("file link refused", { ...fields, file_id: id, code: "file_open_none" });
      return { url: null };
    }
    const url = await deps.store.presignDownload({
      key: found.object_key,
      contentType: found.media_type,
      disposition: dispositionFor(found.media_type),
      expiresSeconds: FILE_LINK_SECONDS,
    });
    deps.logger.info("file link issued", { ...fields, file_id: id, code: "file_open" });
    return { url };
  } catch (e) {
    deps.logger.error("file link failed", { ...fields, file_id: id, ...errorFields(e) });
    return { url: null };
  }
}

/**
 * The page's checks for reading the list (token, then principal), as
 * `loadApprovalPage` runs them; one statement.
 */
async function mayRead(db: A2hDb, c: FilesCaller): Promise<boolean> {
  if (c.token === undefined || !ApprovalTokenSchema.safeParse(c.token).success) return false;
  const presented = await approvalTokenHash(c.token);
  const [r] = await db
    .select({ principal_id: requests.principal_id, token_hash: requests.approval_token_hash })
    .from(requests)
    .where(eq(requests.id, c.requestId));
  return r !== undefined && r.token_hash !== null && r.token_hash === presented && r.principal_id === c.principalId;
}

/** The request's files with their current states (the page polls this while files are uploading or checking). */
export async function listFiles(deps: FilesDeps, c: FilesCaller): Promise<FilesResult> {
  const fields = { request_id: c.requestId, principal_id: c.principalId };
  try {
    if (!(await mayRead(deps.db, c))) return { kind: "unavailable" };
    return { kind: "files", files: (await listRequestFiles(deps.db, c.requestId)).map(approvalFileOf) };
  } catch (e) {
    deps.logger.error("file list failed", { ...fields, ...errorFields(e) });
    return { kind: "unavailable" };
  }
}

/**
 * The browser's POST to storage failed or was cut: the file is refused
 * (`upload_failed`, D1) so that it never waits for a check that will not
 * come, and whatever part of it reached storage is deleted.
 */
export async function uploadFailed(deps: FilesDeps, c: FilesCaller, fileId: unknown): Promise<FilesResult> {
  const fields = { request_id: c.requestId, principal_id: c.principalId };
  if (!FileIdSchema.safeParse(fileId).success) return { kind: "unavailable" };
  const id = fileId as string;
  try {
    if (!(await mayRead(deps.db, c))) return { kind: "unavailable" };
    const mine = (await listRequestFiles(deps.db, c.requestId)).some((f) => f.id === id);
    if (mine) {
      const refused = await refuseFile(deps.db, id, "upload_failed");
      if (refused) {
        deps.logger.info("file upload failed", { ...fields, file_id: id, code: "file_refused_upload_failed" });
        try {
          await deps.store.deleteObject(refused.object_key);
        } catch (e) {
          deps.logger.warn("file object not deleted", { ...fields, file_id: id, ...errorFields(e), code: "file_object_delete_failed" });
        }
      }
    }
    return { kind: "files", files: (await listRequestFiles(deps.db, c.requestId)).map(approvalFileOf) };
  } catch (e) {
    deps.logger.error("file upload failure not recorded", { ...fields, file_id: id, ...errorFields(e) });
    return { kind: "unavailable" };
  }
}
