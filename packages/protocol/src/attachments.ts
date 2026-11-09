// Files a principal attaches to a request (m2-attachments; spec
// platform/attachments, protocol/schemas; design D1, D7, D8). Pure: the
// randomness of a file id is an argument.
import * as z from "zod";
import type { ProtocolError } from "./errors.ts";
import { AttachmentSchema, OpaqueIdSchema, REQUEST_ID_PATTERN } from "./primitives.ts";

/** At most this many files per request (proposal decision 3). */
export const ATTACHMENTS_MAX = 5;
/** Each file at most 25 MB (the protocol's existing per-attachment limit). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** All files of one request together at most 50 MB; also the most a participant's setting can accept. */
export const ATTACHMENTS_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * The media types a request may carry (proposal decision 1), identified from
 * the file's bytes on the server, never from its name or the browser's claim.
 */
export const ATTACHMENT_MEDIA_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "text/csv", "text/markdown"] as const;
export const AttachmentMediaTypeSchema = z.enum(ATTACHMENT_MEDIA_TYPES);
export type AttachmentMediaType = z.infer<typeof AttachmentMediaTypeSchema>;

/** A file of a request as the manifest carries it: an opaque reference, an allowed type, a size. */
export const RequestAttachmentSchema = AttachmentSchema.extend({ media_type: AttachmentMediaTypeSchema });
export type RequestAttachment = z.infer<typeof RequestAttachmentSchema>;

/** Sum of the sizes of a list of files. */
export function totalBytes(files: readonly { size_bytes: number }[] | null | undefined): number {
  return (files ?? []).reduce((sum, f) => sum + f.size_bytes, 0);
}

// ---- the participant's setting (design D7) ----------------------------------

/** Whether the participant accepts files, and the total per request they accept. */
export const AttachmentSettingSchema = z.strictObject({
  accepted: z.boolean(),
  max_total_bytes: z.int().min(0).max(ATTACHMENTS_MAX_TOTAL_BYTES),
});
export type AttachmentSetting = z.infer<typeof AttachmentSettingSchema>;

/**
 * What rules recorded before the setting existed read as (proposal decision
 * 4): files accepted up to 50 MB, until participants set it at onboarding.
 */
export const DEFAULT_ATTACHMENT_SETTING: AttachmentSetting = Object.freeze({ accepted: true, max_total_bytes: ATTACHMENTS_MAX_TOTAL_BYTES });

// ---- what check_requests reports (design D8) --------------------------------

/** One file as agents see it: type and size, never a name, a link or content. */
export const FileSummarySchema = z.strictObject({
  media_type: AttachmentMediaTypeSchema,
  size_bytes: z.int().min(1).max(ATTACHMENT_MAX_BYTES),
});
export type FileSummary = z.infer<typeof FileSummarySchema>;

/** The summary of a request's files, in the order attached; none → []. */
export function fileSummaryOf(attachments: readonly { media_type: string; size_bytes: number }[] | null | undefined): FileSummary[] {
  return (attachments ?? []).map((a) => ({ media_type: a.media_type as AttachmentMediaType, size_bytes: a.size_bytes }));
}

// ---- one stored file (design D1) ---------------------------------------------

/** `uploading` → `checking` → `ready`, or `refused` from either; nothing leaves `ready` or `refused`. */
export const FILE_STATES = ["uploading", "checking", "ready", "refused"] as const;
export const FileStateSchema = z.enum(FILE_STATES);
export type FileState = z.infer<typeof FileStateSchema>;

/** Why a file was refused; the page states each in plain words, never a detection name. */
export const FILE_REFUSED_REASONS = ["type", "size", "count", "malware", "not_checked", "upload_failed"] as const;
export const FileRefusedReasonSchema = z.enum(FILE_REFUSED_REASONS);
export type FileRefusedReason = z.infer<typeof FileRefusedReasonSchema>;

/** A file's id: `f` + 16 random bytes in base64url (22 characters), an opaque id and the manifest's `ref`. */
export const FILE_ID_PATTERN = /^f[A-Za-z0-9_-]{22}$/;
export const FileIdSchema = OpaqueIdSchema.regex(FILE_ID_PATTERN, "file id");
export type FileId = z.infer<typeof FileIdSchema>;

const FILE_ID_BYTES = 16;
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * A file id from 16 random bytes drawn by the caller. The `f` prefix keeps
 * the id an opaque id (which must start with a letter or digit) whatever the
 * bytes are.
 */
export function formatFileId(randomness: Uint8Array): string {
  if (randomness.length !== FILE_ID_BYTES) throw new RangeError(`exactly ${FILE_ID_BYTES} bytes of randomness are required`);
  let bits = 0;
  let value = 0;
  let out = "f";
  for (const byte of randomness) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64URL[(value >> bits) & 63];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B64URL[(value << (6 - bits)) & 63];
  return out;
}

/**
 * The refusal of Send while a file is uploading or being checked, or a
 * refused file is still listed (design D4). Category text only: no file
 * name, no detection.
 */
export function filesNotReadyError(): ProtocolError {
  return { code: "files_not_ready", stage: "lifecycle", retryable: true, detail: "Files are still being checked, or a refused file is still attached." };
}

// ---- the malware scan (ADR 0005 items 4 to 6) ---------------------------------

/**
 * What a scan concluded, whatever scanner produced it: `clean` (nothing
 * found), `threat` (malware found), `error` (the scanner could not read or
 * finish the file, for example a password-protected PDF). The detection name,
 * hash and reasons are dropped by the scanner's adapter and have no place here.
 */
export const FILE_SCAN_OUTCOMES = ["clean", "threat", "error"] as const;
export const FileScanOutcomeSchema = z.enum(FILE_SCAN_OUTCOMES);
export type FileScanOutcome = z.infer<typeof FileScanOutcomeSchema>;

/** The provider-neutral scan result the worker codes against (ADR 0005 item 5). */
export const FileScanResultSchema = z.strictObject({
  file_id: FileIdSchema,
  outcome: FileScanOutcomeSchema,
});
export type FileScanResult = z.infer<typeof FileScanResultSchema>;

// ---- where a file is stored (design D2, D3) -----------------------------------

/** `tmp`: uploaded, not yet checked; `uploads`: checked and clean. */
export const FILE_AREAS = ["tmp", "uploads"] as const;
export type FileArea = (typeof FILE_AREAS)[number];

const STORAGE_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*\/$/;

/** `<area>/<STORAGE_PREFIX>files/<request_id>/<file_id>`: the only keys files are stored under. */
export function fileObjectKey(area: FileArea, storagePrefix: string, requestId: string, fileId: string): string {
  if (!STORAGE_PREFIX_PATTERN.test(storagePrefix)) throw new RangeError("malformed storage prefix");
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new RangeError("malformed request id");
  if (!FILE_ID_PATTERN.test(fileId)) throw new RangeError("malformed file id");
  return `${area}/${storagePrefix}files/${requestId}/${fileId}`;
}

/** The area, request and file of a key of this stage's files; null for any other key. */
export function parseFileObjectKey(key: string, storagePrefix: string): { area: FileArea; request_id: string; file_id: string } | null {
  for (const area of FILE_AREAS) {
    const head = `${area}/${storagePrefix}files/`;
    if (!key.startsWith(head)) continue;
    const parts = key.slice(head.length).split("/");
    if (parts.length !== 2) return null;
    const [requestId, fileId] = parts as [string, string];
    if (!REQUEST_ID_PATTERN.test(requestId) || !FILE_ID_PATTERN.test(fileId)) return null;
    return { area, request_id: requestId, file_id: fileId };
  }
  return null;
}
