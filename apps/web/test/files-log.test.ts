// m2-attachments task 5.3, spec platform/attachments "Logs of an upload": no
// log line of the file actions carries a file's name, whatever the path
// (added, refused for each reason, another account, removed, opened, upload
// failed, the storage failing, the database failing with the name quoted in
// its message). The test also checks it went through every log code the
// actions have, so a new log line without a case here fails it.
import { markFileChecking, markFileReady } from "@a2h/db";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import type { FileStore } from "../infra/files";
import { decide } from "../src/approval/decide";
import { addFile, listFiles, openFile, removeFile, uploadFailed, type FilesDeps } from "../src/approval/files";
import { createLogger } from "../src/log";
import { awaiting, principal, startApprovalDb, type ApprovalDb } from "./lib/approval-db";

const adminUrl = inject("pgAdminUrl");
const NAME = "Board-minutes Q3 acquisition of Ørsted.pdf";
/** Every piece of the name that could leak on its own. */
const PIECES = ["Board-minutes", "acquisition", "Ørsted", "Q3 acq"];
const MB = 1024 * 1024;

/** What drizzle throws when a statement fails: the driver's error as the cause, the name quoted in it. */
function dbFailure(): Error {
  const cause = Object.assign(new Error(`ERROR: value too long "${NAME}" Detail: Failing row contains (${NAME}).; SQLState: 22001`), { name: "DatabaseErrorException" });
  return new Error(`Failed query: insert into "request_files" ("name") values (:1)\nparams: ${NAME}`, { cause });
}

function failingDb(): never {
  const fail = () => {
    throw dbFailure();
  };
  return { select: fail, update: fail, insert: fail, execute: fail, transaction: fail } as never;
}

describe.skipIf(!adminUrl)("Logs of an upload: no file name in any log line", () => {
  let d: ApprovalDb;
  let me: string;
  let other: string;
  const lines: string[] = [];
  const logger = createLogger({ write: (l) => lines.push(l), level: "debug" });
  const store: FileStore = {
    presignUpload: (i) => Promise.resolve({ url: "https://storage.example/b", fields: { key: i.key } }),
    presignDownload: (i) => Promise.resolve(`https://storage.example/b/${i.key}`),
    deleteObject: () => Promise.resolve(),
  };
  /** The storage refusing, with the name in its message (as a misconfigured adapter might put it). */
  const brokenStore: FileStore = {
    presignUpload: () => Promise.reject(Object.assign(new Error(`cannot sign ${NAME}`), { name: "S3ServiceException" })),
    presignDownload: () => Promise.reject(Object.assign(new Error(`cannot sign ${NAME}`), { name: "S3ServiceException" })),
    deleteObject: () => Promise.reject(Object.assign(new Error(`AccessDenied on ${NAME}`), { name: "AccessDenied" })),
  };
  let deps: FilesDeps;

  beforeAll(async () => {
    d = await startApprovalDb(adminUrl, "web_files_log");
    me = await principal(d, "user-files-log-me");
    other = await principal(d, "user-files-log-other");
    deps = { db: d.db, store, logger, storagePrefix: "pr-12/" };
  });
  afterAll(async () => {
    await d?.close();
  });

  test("every path of add, remove, open, list and upload failure", async () => {
    const a = await awaiting(d, me);
    const c = { requestId: a.id, token: a.token, principalId: me };
    const pdf = (size: number) => ({ name: NAME, type: "application/pdf", size });

    // Add: malformed, empty, type, size, total, count, another account, added, storage failing, database failing.
    await addFile(deps, c, { name: NAME, type: "application/pdf", size: -1 });
    await addFile(deps, c, pdf(0));
    await addFile(deps, c, { name: NAME, type: "application/x-msdownload", size: 10 });
    await addFile(deps, c, pdf(25 * MB + 1));
    await addFile(deps, { ...c, principalId: other }, pdf(10));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await addFile(deps, c, pdf(i === 0 ? 25 * MB : i === 1 ? 20 * MB : 10));
      if (r.kind === "added") ids.push(r.file.id);
    }
    await addFile(deps, c, pdf(10));
    const b = await awaiting(d, me);
    const cb = { requestId: b.id, token: b.token, principalId: me };
    // The total: 25 MB and 25 MB held, one byte more is over 50 MB.
    await addFile(deps, cb, pdf(25 * MB));
    await addFile(deps, cb, pdf(25 * MB));
    await addFile(deps, cb, pdf(1));
    await addFile({ ...deps, store: brokenStore }, c, pdf(10));
    await addFile({ ...deps, db: failingDb() }, c, pdf(10));

    // Ready one file to open it.
    await markFileChecking(d.db, ids[2]!, "application/pdf");
    await markFileReady(d.db, ids[2]!, `uploads/pr-12/files/${a.id}/${ids[2]}`, new Date());

    // Open: issued, none, another account, storage failing, database failing.
    await openFile(deps, c, ids[2]);
    await openFile(deps, c, ids[3]);
    await openFile(deps, { ...c, principalId: other }, ids[2]);
    await openFile({ ...deps, store: brokenStore }, c, ids[2]);
    await openFile({ ...deps, db: failingDb() }, c, ids[2]);

    // List: fine, another account, database failing.
    await listFiles(deps, c);
    await listFiles(deps, { ...c, principalId: other });
    await listFiles({ ...deps, db: failingDb() }, c);

    // Upload failed: refused, storage failing to delete, database failing.
    await uploadFailed(deps, c, ids[3]);
    await uploadFailed({ ...deps, store: brokenStore }, c, ids[4]);
    await uploadFailed({ ...deps, db: failingDb() }, c, ids[4]);

    // Remove: removed, not found, another account, storage failing to delete, database failing.
    await removeFile(deps, c, ids[0]);
    await removeFile(deps, c, ids[0]);
    await removeFile(deps, { ...c, principalId: other }, ids[1]);
    await removeFile({ ...deps, store: brokenStore }, c, ids[1]);
    await removeFile({ ...deps, db: failingDb() }, c, ids[2]);

    // Send refused while a file is not ready (files_not_ready), then Send with the files ready.
    const form = new FormData();
    form.set("decision", "send");
    form.set("question", "Would a patient with type 2 diabetes find the leaflet's section on insulin alarming?");
    await decide({ db: d.db, feeRate: 0.2, logger }, { requestId: a.id, token: a.token, principalId: me, form, reference: "ref_log" });

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const codes = new Set(parsed.map((l) => String(l["code"])));
    for (const code of [
      "file_add_malformed",
      "file_refused_type",
      "file_refused_size",
      "file_refused_total",
      "file_refused_count",
      "file_add_wrong_principal",
      "file_added",
      "S3ServiceException",
      "Error",
      "file_open",
      "file_open_none",
      "file_refused_upload_failed",
      "file_object_delete_failed",
      "file_removed",
      "file_remove_not_found",
      "file_remove_wrong_principal",
      "approval_invalid",
    ]) {
      expect(codes, code).toContain(code);
    }
    const all = lines.join("\n");
    for (const piece of [NAME, ...PIECES]) expect(all).not.toContain(piece);
    // Opaque file ids are allowed and present.
    expect(parsed.some((l) => typeof l["file_id"] === "string" && /^f[A-Za-z0-9_-]{22}$/.test(l["file_id"]))).toBe(true);
    // Nor a key or a link.
    expect(all).not.toMatch(/tmp\/pr-12\/files|uploads\/pr-12\/files|storage\.example/);
  });
});
