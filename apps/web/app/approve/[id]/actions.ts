"use server";
// Send and Don't send (m2-approval-page task 5.2, design D4), and the files
// of the request (m2-attachments task 5.1, design D2, D5, D6). The session is
// the authority: its principal decides, after the allow-list re-check every
// session read runs (src/auth/auth.ts allowlistGate). The token comes from
// the page's HttpOnly cookie (src/approval/link.ts), never from the form or
// the call's arguments.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { decide, type ApprovalActionState } from "../../../src/approval/decide";
import {
  addFile,
  listFiles,
  openFile,
  removeFile,
  uploadFailed,
  type AddFileResult,
  type FilesCaller,
  type FilesDeps,
  type FilesResult,
  type OpenFileResult,
  type RemoveFileResult,
} from "../../../src/approval/files";
import { APPROVAL_COOKIE, approvalPath } from "../../../src/approval/link";
import { ROUTES } from "../../../src/auth/auth";
import { getRuntime } from "../../../src/server/runtime";

function reference(): string {
  return `ref_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

async function sessionHeaders(): Promise<Headers> {
  const h = new Headers();
  (await headers()).forEach((value, key) => h.set(key, value));
  return h;
}

export async function approvalAction(requestId: string, _prev: ApprovalActionState, form: FormData): Promise<ApprovalActionState> {
  const path = approvalPath(requestId);
  if (path === undefined) return { state: "expired" };
  const runtime = await getRuntime();
  const session = await runtime.auth.api.getSession({ headers: await sessionHeaders() });
  // Signed out meanwhile (or removed from the allow-list): sign in, then back to the same page.
  if (!session) redirect(`${ROUTES.signIn}?next=${encodeURIComponent(path)}`);
  return decide(
    { db: runtime.db, feeRate: runtime.config.feeRate, logger: runtime.logger },
    { requestId, token: (await cookies()).get(APPROVAL_COOKIE)?.value, principalId: session.user.id, form, reference: reference() },
  );
}

/**
 * The page's checks before any file action: a well-formed id and a signed-in
 * principal. Signed out, a file action changes nothing and the page keeps
 * the principal's edits; the next Send leads to sign-in.
 */
async function filesContext(requestId: string): Promise<{ deps: FilesDeps; caller: FilesCaller } | undefined> {
  if (approvalPath(requestId) === undefined) return undefined;
  const runtime = await getRuntime();
  const session = await runtime.auth.api.getSession({ headers: await sessionHeaders() });
  if (!session) return undefined;
  return {
    deps: { db: runtime.db, store: runtime.files, logger: runtime.logger, storagePrefix: runtime.config.storagePrefix },
    caller: { requestId, token: (await cookies()).get(APPROVAL_COOKIE)?.value, principalId: session.user.id },
  };
}

/** Record a file about to be uploaded and return its 5-minute upload policy (D2). `file`: name, type, size as the browser gives them. */
export async function addFileAction(requestId: string, file: unknown): Promise<AddFileResult> {
  const c = await filesContext(requestId);
  return c ? addFile(c.deps, c.caller, file) : { kind: "unavailable" };
}

/** Remove a file before Send; its object is deleted at once (D5). */
export async function removeFileAction(requestId: string, fileId: unknown): Promise<RemoveFileResult> {
  const c = await filesContext(requestId);
  return c ? removeFile(c.deps, c.caller, fileId) : { kind: "unavailable" };
}

/** A 5-minute link to a ready file of the principal's own request (D6). */
export async function openFileAction(requestId: string, fileId: unknown): Promise<OpenFileResult> {
  const c = await filesContext(requestId);
  return c ? openFile(c.deps, c.caller, fileId) : { url: null };
}

/** The files and their states, for the page's refresh while files upload or are checked. */
export async function listFilesAction(requestId: string): Promise<FilesResult> {
  const c = await filesContext(requestId);
  return c ? listFiles(c.deps, c.caller) : { kind: "unavailable" };
}

/** The browser's upload to storage failed: refuse the file (`upload_failed`). */
export async function uploadFailedAction(requestId: string, fileId: unknown): Promise<FilesResult> {
  const c = await filesContext(requestId);
  return c ? uploadFailed(c.deps, c.caller, fileId) : { kind: "unavailable" };
}
