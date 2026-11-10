// m2-attachments task 5.1 against PostgreSQL 17: the approval page's file
// actions (src/approval/files.ts) behind the page's token and principal,
// with a recording FileStore in place of S3 (the real presigned links are
// pinned in files-storage.test.ts, and refused by a real storage there).
// Scenario names are the spec's (platform/attachments,
// platform/approval-page).
import { markFileChecking, markFileReady, refuseFile } from "@a2h/db";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from "vitest";
import type { FileStore } from "../infra/files";
import { decide } from "../src/approval/decide";
import { loadApprovalPage } from "../src/approval/page-data";
import { addFile, dispositionFor, FILE_RULES, listFiles, openFile, removeFile, storedName, uploadFailed, uploadKey, type FilesDeps } from "../src/approval/files";
import { createLogger } from "../src/log";
import { awaiting, principal, startApprovalDb, type ApprovalDb, type Awaiting } from "./lib/approval-db";

const adminUrl = inject("pgAdminUrl");
const MB = 1024 * 1024;
const PREFIX = "pr-12/";

interface StoreCall {
  op: "upload" | "download" | "delete";
  [k: string]: unknown;
}

function recordingStore(calls: StoreCall[]): FileStore {
  return {
    presignUpload: (i) => {
      calls.push({ op: "upload", ...i });
      return Promise.resolve({ url: "https://storage.example/bucket", fields: { key: i.key, "Content-Type": i.contentType, Policy: "p" } });
    },
    presignDownload: (i) => {
      calls.push({ op: "download", ...i });
      return Promise.resolve(`https://storage.example/bucket/${i.key}?X-Amz-Expires=${i.expiresSeconds}`);
    },
    deleteObject: (key) => {
      calls.push({ op: "delete", key });
      return Promise.resolve();
    },
  };
}

describe("pure parts", () => {
  test("keys carry ids only: tmp/<prefix>files/<request>/<file>", () => {
    expect(uploadKey("pr-12/", "A2H-7f3c", "fAAAAAAAAAAAAAAAAAAAAAA")).toBe("tmp/pr-12/files/A2H-7f3c/fAAAAAAAAAAAAAAAAAAAAAA");
  });

  test("D6: images inline, documents as attachments", () => {
    expect(dispositionFor("image/png")).toBe("inline");
    expect(dispositionFor("image/jpeg")).toBe("inline");
    expect(dispositionFor("image/webp")).toBe("inline");
    for (const t of ["application/pdf", "text/plain", "text/csv", "text/markdown"]) expect(dispositionFor(t)).toBe("attachment");
  });

  test("names: at most 255 UTF-16 units without splitting a character; an empty one gets a name", () => {
    expect(storedName("a".repeat(300))).toHaveLength(255);
    const cut = storedName("a".repeat(254) + "😀b");
    expect(cut).toBe("a".repeat(254));
    expect(storedName("   ")).toBe("file");
  });

  test("the rules the page states are the protocol's constants", () => {
    expect(FILE_RULES).toEqual({
      accept: ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "text/csv", "text/markdown"],
      maxFiles: 5,
      maxFileBytes: 25 * MB,
      maxTotalBytes: 50 * MB,
    });
  });
});

describe.skipIf(!adminUrl)("file actions against the database", () => {
  let d: ApprovalDb;
  let calls: StoreCall[];
  let deps: FilesDeps;
  let me: string;
  let other: string;
  let a: Awaiting;
  const caller = (x: Awaiting, principalId = me, token: string | undefined = x.token) => ({ requestId: x.id, token, principalId });
  const pdf = (name = "leaflet.pdf", size = 2 * MB) => ({ name, type: "application/pdf", size });

  async function added(x: Awaiting, file = pdf()): Promise<string> {
    const r = await addFile(deps, caller(x), file);
    if (r.kind !== "added") throw new Error(`not added: ${r.kind}`);
    return r.file.id;
  }

  async function ready(id: string, type = "application/pdf"): Promise<void> {
    expect(await markFileChecking(d.db, id, type, "9b2cf535f27731c974343645a3985328")).toBe(true);
    const [row] = await d.sql<{ object_key: string }>("SELECT object_key FROM request_files WHERE id = $1", [id]);
    expect(await markFileReady(d.db, id, row!.object_key.replace(/^tmp\//, "uploads/"), new Date(), "9b2cf535f27731c974343645a3985328")).toBe(true);
  }

  async function rows(x: Awaiting) {
    return d.sql<{ id: string; state: string; deleted_at: Date | null }>("SELECT id, state, deleted_at FROM request_files WHERE request_id = $1 ORDER BY seq", [x.id]);
  }

  beforeAll(async () => {
    d = await startApprovalDb(adminUrl, "web_files");
    me = await principal(d, "user-files-me");
    other = await principal(d, "user-files-other");
  });
  afterAll(async () => {
    await d?.close();
  });
  beforeEach(async () => {
    calls = [];
    deps = { db: d.db, store: recordingStore(calls), logger: createLogger({ write: () => {}, level: "debug" }), storagePrefix: PREFIX };
    a = await awaiting(d, me);
  });

  describe("Requirement: Only allowed files of bounded size", () => {
    test("an allowed file: an uploading row, and a presigned POST for its key, its declared type, exactly its declared size (review B1), 5 minutes", async () => {
      const r = await addFile(deps, caller(a), pdf());
      expect(r.kind).toBe("added");
      if (r.kind !== "added") return;
      expect(r.file).toEqual({ id: r.file.id, name: "leaflet.pdf", mediaType: "application/pdf", sizeBytes: 2 * MB, state: "uploading" });
      expect(r.file.id).toMatch(/^f[A-Za-z0-9_-]{22}$/);
      expect(calls).toEqual([{ op: "upload", key: `tmp/pr-12/files/${a.id}/${r.file.id}`, contentType: "application/pdf", sizeBytes: 2 * MB, expiresSeconds: 300 }]);
      expect(r.upload.fields["key"]).toBe(`tmp/pr-12/files/${a.id}/${r.file.id}`);
      expect(await rows(a)).toMatchObject([{ id: r.file.id, state: "uploading", deleted_at: null }]);
    });

    test("Too large: a file over 25 MB is refused before anything is stored, with the per-file limit", async () => {
      expect(await addFile(deps, caller(a), pdf("big.pdf", 25 * MB + 1))).toEqual({ kind: "refused", refusal: "size" });
      expect(await rows(a)).toEqual([]);
      expect(calls).toEqual([]);
    });

    test("Too large: a file that would take the request over 50 MB is refused, with the total limit", async () => {
      await added(a, pdf("one.pdf", 25 * MB));
      await added(a, pdf("two.pdf", 20 * MB));
      expect(await addFile(deps, caller(a), pdf("three.pdf", 5 * MB + 1))).toEqual({ kind: "refused", refusal: "total" });
      expect(await rows(a)).toHaveLength(2);
      expect((await addFile(deps, caller(a), pdf("fits.pdf", 5 * MB))).kind).toBe("added");
    });

    test("Too many: with 5 files held a sixth is refused with the limit; a refused file does not count", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await added(a, pdf(`f${i}.pdf`, 1000)));
      expect(await addFile(deps, caller(a), pdf("sixth.pdf", 1000))).toEqual({ kind: "refused", refusal: "count" });
      expect(await rows(a)).toHaveLength(5);
      expect(await refuseFile(d.db, ids[0]!, "type")).not.toBeNull();
      expect((await addFile(deps, caller(a), pdf("sixth.pdf", 1000))).kind).toBe("added");
    });

    test("a type that is not allowed, by the browser's claim, is refused before storing; an empty file too", async () => {
      expect(await addFile(deps, caller(a), { name: "archive.zip", type: "application/zip", size: 1000 })).toEqual({ kind: "refused", refusal: "type" });
      expect(await addFile(deps, caller(a), { name: "empty.txt", type: "text/plain", size: 0 })).toEqual({ kind: "refused", refusal: "type" });
      expect(await rows(a)).toEqual([]);
    });

    test("a malformed call (not the shape the page sends) changes nothing", async () => {
      expect(await addFile(deps, caller(a), { name: "x.pdf", type: "application/pdf", size: -1 })).toEqual({ kind: "unavailable" });
      expect(await addFile(deps, caller(a), { name: "x.pdf", type: "application/pdf", size: 1, extra: 1 })).toEqual({ kind: "unavailable" });
      expect(await addFile(deps, caller(a), "x.pdf")).toEqual({ kind: "unavailable" });
      expect(await rows(a)).toEqual([]);
    });
  });

  describe("Requirement: Only the request's principal can read files before M3", () => {
    test("Principal opens their file: a 5-minute link to the clean copy, with its recorded type, as an attachment (PDF)", async () => {
      const id = await added(a);
      await ready(id);
      calls.length = 0;
      const r = await openFile(deps, caller(a), id);
      expect(r.url).toBe(`https://storage.example/bucket/uploads/pr-12/files/${a.id}/${id}?X-Amz-Expires=300`);
      expect(calls).toEqual([{ op: "download", key: `uploads/pr-12/files/${a.id}/${id}`, contentType: "application/pdf", disposition: "attachment", expiresSeconds: 300 }]);
    });

    test("Principal opens their file: an image opens inline", async () => {
      const id = await added(a, { name: "chart.png", type: "image/png", size: 3000 });
      await ready(id, "image/png");
      calls.length = 0;
      expect((await openFile(deps, caller(a), id)).url).not.toBeNull();
      expect(calls[0]).toMatchObject({ contentType: "image/png", disposition: "inline" });
    });

    test("a file not ready yet has no link", async () => {
      const id = await added(a);
      calls.length = 0;
      expect(await openFile(deps, caller(a), id)).toEqual({ url: null });
      expect(calls).toEqual([]);
    });

    test("Another account: nothing is returned that reveals the file exists (the same answer as an unknown file)", async () => {
      const id = await added(a);
      await ready(id);
      calls.length = 0;
      const unknown = await openFile(deps, caller(a, other), "f" + "Z".repeat(22));
      // With the owner's token (a leaked cookie), without it, and with a token of the other account's own request.
      const theirs = await awaiting(d, other);
      for (const c of [caller(a, other), caller(a, other, undefined), caller(a, other, theirs.token)]) {
        expect(await openFile(deps, c, id)).toEqual(unknown);
      }
      expect(unknown).toEqual({ url: null });
      expect(await openFile(deps, caller(theirs, other), id)).toEqual({ url: null });
      expect(calls).toEqual([]);
    });

    test("Another account cannot list, add, remove or mark a file of the request", async () => {
      const id = await added(a);
      expect(await listFiles(deps, caller(a, other))).toEqual({ kind: "unavailable" });
      expect(await addFile(deps, caller(a, other), pdf())).toEqual({ kind: "unavailable" });
      expect(await removeFile(deps, caller(a, other), id)).toEqual({ kind: "unavailable" });
      expect(await uploadFailed(deps, caller(a, other), id)).toEqual({ kind: "unavailable" });
      expect(await rows(a)).toMatchObject([{ id, state: "uploading", deleted_at: null }]);
    });

    test("Old link: the page's link to a file lasts 5 minutes (storage refusing it after: files-storage.test.ts)", async () => {
      const id = await added(a);
      await ready(id);
      calls.length = 0;
      await openFile(deps, caller(a), id);
      expect(calls[0]).toMatchObject({ op: "download", expiresSeconds: 300 });
    });

    test("an expired approval link reads, adds and removes nothing", async () => {
      const id = await added(a);
      await ready(id);
      calls.length = 0;
      const later = { ...deps, now: () => new Date(Date.now() + 25 * 3_600_000) };
      expect(await openFile(later, caller(a), id)).toEqual({ url: null });
      expect(await addFile(later, caller(a), pdf())).toEqual({ kind: "unavailable" });
      expect(await removeFile(later, caller(a), id)).toEqual({ kind: "unavailable" });
      expect(calls).toEqual([]);
    });
  });

  describe("Requirement: The principal can attach files before Send", () => {
    test("Remove a file: it leaves the list, its object is deleted at once, and it is not part of the request", async () => {
      const keep = await added(a, pdf("keep.pdf"));
      const gone = await added(a, pdf("gone.pdf"));
      await ready(gone);
      calls.length = 0;
      expect(await removeFile(deps, caller(a), gone)).toEqual({ kind: "removed" });
      expect(calls).toEqual([{ op: "delete", key: `uploads/pr-12/files/${a.id}/${gone}` }]);
      const list = await listFiles(deps, caller(a));
      expect(list.kind === "files" && list.files.map((f) => f.id)).toEqual([keep]);
      // Removing it again: nothing left to do, still removed.
      expect(await removeFile(deps, caller(a), gone)).toEqual({ kind: "removed" });
    });

    test("the list carries states and reasons as the page shows them", async () => {
      const x = await added(a, pdf("x.pdf"));
      const y = await added(a, { name: "notes.txt", type: "text/plain", size: 68 });
      await refuseFile(d.db, y, "malware");
      const list = await listFiles(deps, caller(a));
      expect(list).toEqual({
        kind: "files",
        files: [
          { id: x, name: "x.pdf", mediaType: "application/pdf", sizeBytes: 2 * MB, state: "uploading" },
          { id: y, name: "notes.txt", mediaType: "text/plain", sizeBytes: 68, state: "refused", refusal: "malware" },
        ],
      });
    });

    test("an upload the browser could not finish is refused as upload_failed and its object deleted", async () => {
      const id = await added(a);
      calls.length = 0;
      const r = await uploadFailed(deps, caller(a), id);
      expect(r).toEqual({ kind: "files", files: [expect.objectContaining({ id, state: "refused", refusal: "upload_failed" })] });
      expect(calls).toEqual([{ op: "delete", key: `tmp/pr-12/files/${a.id}/${id}` }]);
      // A file already past its upload is left as it is.
      const done = await added(a, pdf("done.pdf"));
      await ready(done);
      calls.length = 0;
      await uploadFailed(deps, caller(a), done);
      expect((await rows(a)).find((r) => r.id === done)?.state).toBe("ready");
      expect(calls).toEqual([]);
    });

    test("Sent files are fixed: after Send nothing is added or removed; the files stay listed and can be opened", async () => {
      const id = await added(a);
      await ready(id);
      const form = new FormData();
      form.set("decision", "send");
      form.set("question", "Would a patient with type 2 diabetes find the leaflet's section on insulin alarming?");
      const sent = await decide({ db: d.db, feeRate: 0.2, logger: deps.logger }, { requestId: a.id, token: a.token, principalId: me, form, reference: "ref_x" });
      expect(sent.state).toBe("sent");
      calls.length = 0;
      expect(await addFile(deps, caller(a), pdf())).toEqual({ kind: "unavailable" });
      expect(await removeFile(deps, caller(a), id)).toEqual({ kind: "unavailable" });
      expect(await rows(a)).toMatchObject([{ id, state: "ready", deleted_at: null }]);
      expect((await openFile(deps, caller(a), id)).url).not.toBeNull();
      expect(await listFiles(deps, caller(a))).toMatchObject({ kind: "files", files: [{ id, state: "ready" }] });
    });

    test("Send waits for checking: Send with a file still checking is refused as files_not_ready, the question kept", async () => {
      const id = await added(a);
      await markFileChecking(d.db, id, "application/pdf", "9b2cf535f27731c974343645a3985328");
      const form = new FormData();
      form.set("decision", "send");
      form.set("question", "Edited question kept?");
      const r = await decide({ db: d.db, feeRate: 0.2, logger: deps.logger }, { requestId: a.id, token: a.token, principalId: me, form, reference: "ref_y" });
      expect(r).toEqual({ state: "refused", refusal: "files_not_ready", question: "Edited question kept?" });
    });
  });
});

describe.skipIf(!adminUrl)("the page's model carries the files", () => {
  let d: ApprovalDb;
  let me: string;
  let deps: FilesDeps;
  beforeAll(async () => {
    d = await startApprovalDb(adminUrl, "web_files_page");
    me = await principal(d, "user-files-page");
    deps = { db: d.db, store: recordingStore([]), logger: createLogger({ write: () => {} }), storagePrefix: PREFIX };
  });
  afterAll(async () => {
    await d?.close();
  });

  test("awaiting: the request's files in the order added, refused ones listed; a request without files: []", async () => {
    const a = await awaiting(d, me);
    const none = await loadApprovalPage(d.db, { requestId: a.id, token: a.token, principalId: me, now: new Date(), feeRate: 0.2 });
    expect(none).toMatchObject({ kind: "awaiting", files: [] });
    const one = await addFile(deps, { requestId: a.id, token: a.token, principalId: me }, { name: "a.pdf", type: "application/pdf", size: 10 });
    const two = await addFile(deps, { requestId: a.id, token: a.token, principalId: me }, { name: "b.txt", type: "text/plain", size: 20 });
    if (one.kind !== "added" || two.kind !== "added") throw new Error("not added");
    await refuseFile(d.db, two.file.id, "type");
    const p = await loadApprovalPage(d.db, { requestId: a.id, token: a.token, principalId: me, now: new Date(), feeRate: 0.2 });
    expect(p.kind === "awaiting" && p.files).toEqual([
      { id: one.file.id, name: "a.pdf", mediaType: "application/pdf", sizeBytes: 10, state: "uploading" },
      { id: two.file.id, name: "b.txt", mediaType: "text/plain", sizeBytes: 20, state: "refused", refusal: "type" },
    ]);
  });

  test("Files on a sent request: the sent page's model lists them", async () => {
    const a = await awaiting(d, me);
    const r = await addFile(deps, { requestId: a.id, token: a.token, principalId: me }, { name: "chart.png", type: "image/png", size: 300 });
    if (r.kind !== "added") throw new Error("not added");
    await markFileChecking(d.db, r.file.id, "image/png", "9b2cf535f27731c974343645a3985328");
    await markFileReady(d.db, r.file.id, `uploads/${PREFIX}files/${a.id}/${r.file.id}`, new Date(), "9b2cf535f27731c974343645a3985328");
    const form = new FormData();
    form.set("decision", "send");
    form.set("question", "Would a patient with type 2 diabetes find the leaflet's section on insulin alarming?");
    expect((await decide({ db: d.db, feeRate: 0.2, logger: deps.logger }, { requestId: a.id, token: a.token, principalId: me, form, reference: "ref_z" })).state).toBe("sent");
    const p = await loadApprovalPage(d.db, { requestId: a.id, token: a.token, principalId: me, now: new Date(), feeRate: 0.2 });
    expect(p).toMatchObject({ kind: "already-sent", files: [{ id: r.file.id, name: "chart.png", mediaType: "image/png", sizeBytes: 300, state: "ready" }] });
  });
});
