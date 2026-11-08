// m2-attachments task 5.2, the page's file handling in the browser
// (src/approval/files-client.ts) with fake actions, a fake upload and a fake
// tab: what `files` the page shows after each step (design.md F0–F12), the
// upload straight to storage with progress, the abort on remove, the tab
// opened inside the click, and the refresh that stops when nothing is left
// to wait for. The real upload against storage is files-storage.test.ts; the
// page in a browser is test/e2e/files.spec.ts.
import { describe, expect, test } from "vitest";
import type { ApprovalFile } from "@a2h/ui";
import type { AddFileResult, FilesResult, OpenFileResult, RemoveFileResult } from "../src/approval/files";
import { declaredType, FilesController, xhrUploader, type FileActions, type Tab, type UploadHandle, type Uploader, type UploadOutcome } from "../src/approval/files-client";

const MB = 1024 * 1024;
const POST = { url: "https://storage.example/b", fields: { key: "tmp/pr-12/files/A2H-1/f1", "Content-Type": "application/pdf", Policy: "p" } };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fileOf(name: string, type: string, size: number): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

const fid = (n: number) => `f${String(n).padStart(22, "A")}`;

function row(id: string, over: Partial<ApprovalFile> = {}): ApprovalFile {
  return { id, name: "leaflet.pdf", mediaType: "application/pdf", sizeBytes: 2 * MB, state: "uploading", ...over };
}

interface FakeUpload {
  file: Blob;
  onProgress: (p: number) => void;
  finish: (o: UploadOutcome) => void;
  aborted: boolean;
}

function harness(initial: ApprovalFile[] = []) {
  const uploads: FakeUpload[] = [];
  const calls: string[] = [];
  let next = 0;
  const addReplies: Array<(f: { name: string; type: string; size: number }) => AddFileResult | Promise<AddFileResult>> = [];
  let listReply: () => FilesResult = () => ({ kind: "files", files: [] });
  let removeReply: () => RemoveFileResult | Promise<RemoveFileResult> = () => ({ kind: "removed" });
  let openReply: () => Promise<OpenFileResult> = () => Promise.resolve({ url: "https://storage.example/b/uploads/x?X-Amz-Expires=300" });
  const actions: FileActions = {
    add: async (f) => {
      calls.push(`add ${f.name} ${f.type} ${f.size}`);
      const reply = addReplies.shift();
      if (reply) return reply(f);
      next += 1;
      return { kind: "added", file: row(fid(next), { name: f.name, mediaType: f.type, sizeBytes: f.size }), upload: POST };
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
      return removeReply();
    },
    open: async (id) => {
      calls.push(`open ${id}`);
      return openReply();
    },
    list: () => {
      calls.push("list");
      return Promise.resolve(listReply());
    },
    uploadFailed: (id) => {
      calls.push(`uploadFailed ${id}`);
      return Promise.resolve(listReply());
    },
  };
  const upload: Uploader = ({ file, onProgress }) => {
    let finish!: (o: UploadOutcome) => void;
    const done = new Promise<UploadOutcome>((r) => (finish = r));
    const u: FakeUpload = { file, onProgress, finish, aborted: false };
    uploads.push(u);
    const handle: UploadHandle = {
      done,
      abort: () => {
        u.aborted = true;
        finish("aborted");
      },
    };
    return handle;
  };
  const tabs: Array<Tab & { closed: boolean; openedSync: boolean }> = [];
  let inClick = false;
  const openTab = () => {
    const t = { opener: {} as unknown, location: { href: "about:blank" }, closed: false, openedSync: inClick, close() { this.closed = true; } };
    tabs.push(t);
    return t;
  };
  const seen: (readonly ApprovalFile[])[] = [];
  const c = new FilesController({ actions, upload, openTab, onChange: (f) => seen.push(f), initial });
  return {
    c,
    calls,
    uploads,
    tabs,
    seen,
    addReplies,
    setList: (f: () => FilesResult) => (listReply = f),
    setRemove: (f: () => RemoveFileResult | Promise<RemoveFileResult>) => (removeReply = f),
    setOpen: (f: () => Promise<OpenFileResult>) => (openReply = f),
    click: (fn: () => Promise<void>) => {
      inClick = true;
      const p = fn();
      inClick = false;
      return p;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("declaredType: what the browser claims, made usable for the policy", () => {
  test("an allowed type is kept", () => {
    expect(declaredType({ name: "a.pdf", type: "application/pdf" })).toBe("application/pdf");
    expect(declaredType({ name: "IMG_2041.jpg", type: "image/jpeg" })).toBe("image/jpeg");
  });
  test("no type or a known mislabel: from the extension (Markdown, CSV); the content check decides", () => {
    expect(declaredType({ name: "notes.md", type: "" })).toBe("text/markdown");
    expect(declaredType({ name: "notes.markdown", type: "text/x-markdown" })).toBe("text/markdown");
    expect(declaredType({ name: "data.CSV", type: "application/vnd.ms-excel" })).toBe("text/csv");
    expect(declaredType({ name: "plain.txt", type: "" })).toBe("text/plain");
  });
  test("anything else is passed as given, and the server refuses it as a type not allowed", () => {
    expect(declaredType({ name: "archive.zip", type: "application/zip" })).toBe("application/zip");
    expect(declaredType({ name: "report.pdf", type: "text/html" })).toBe("text/html");
    expect(declaredType({ name: "noext", type: "" })).toBe("");
  });
});

describe("FilesController", () => {
  test("Add: a row at once (uploading), then the server's row, the upload straight to storage with progress, then checking", async () => {
    const h = harness();
    const adding = h.c.add([fileOf("leaflet.pdf", "application/pdf", 2 * MB)]);
    expect(h.c.files).toEqual([expect.objectContaining({ name: "leaflet.pdf", state: "uploading", sizeBytes: 2 * MB })]);
    await adding;
    expect(h.calls).toEqual([`add leaflet.pdf application/pdf ${2 * MB}`]);
    expect(h.c.files).toEqual([row(fid(1), { name: "leaflet.pdf" })]);
    expect(h.uploads).toHaveLength(1);
    h.uploads[0]!.onProgress(0.42);
    expect(h.c.files[0]).toMatchObject({ state: "uploading", progress: 0.42 });
    h.uploads[0]!.finish("ok");
    await settle();
    expect(h.c.files[0]).toMatchObject({ id: fid(1), state: "checking" });
    expect(h.c.files[0]).not.toHaveProperty("progress");
    expect(h.c.busy).toBe(true);
  });

  test("several files: added in order, one call at a time, uploads in parallel", async () => {
    const h = harness();
    await h.c.add([fileOf("a.pdf", "application/pdf", 10), fileOf("b.png", "image/png", 20)]);
    expect(h.calls).toEqual(["add a.pdf application/pdf 10", "add b.png image/png 20"]);
    expect(h.c.files.map((f) => f.name)).toEqual(["a.pdf", "b.png"]);
    expect(h.uploads).toHaveLength(2);
  });

  test("Too large, Too many, total, type: refused before storing, kept as a local row with its reason until removed", async () => {
    const h = harness();
    h.addReplies.push(() => ({ kind: "refused", refusal: "size" }), () => ({ kind: "refused", refusal: "total" }), () => ({ kind: "refused", refusal: "count" }), () => ({ kind: "refused", refusal: "type" }));
    await h.c.add([fileOf("big.pdf", "application/pdf", 26 * MB), fileOf("c.pdf", "application/pdf", 1), fileOf("d.pdf", "application/pdf", 1), fileOf("e.zip", "application/zip", 1)]);
    expect(h.c.files.map((f) => [f.state, f.refusal])).toEqual([
      ["refused", "size"],
      ["refused", "total"],
      ["refused", "count"],
      ["refused", "type"],
    ]);
    expect(h.uploads).toEqual([]);
    const id = h.c.files[0]!.id;
    await h.c.remove(id);
    // A local row is dropped without asking the server.
    expect(h.calls.filter((x) => x.startsWith("remove"))).toEqual([]);
    expect(h.c.files).toHaveLength(3);
  });

  test("the add action unavailable (link expired, signed out): the row says the upload did not finish", async () => {
    const h = harness();
    h.addReplies.push(() => ({ kind: "unavailable" }));
    await h.c.add([fileOf("a.pdf", "application/pdf", 10)]);
    expect(h.c.files[0]).toMatchObject({ state: "refused", refusal: "upload_failed" });
  });

  test("the add action throwing (network): the same, and the next file is still added", async () => {
    const h = harness();
    h.addReplies.push(() => Promise.reject(new Error("Failed to fetch")));
    await h.c.add([fileOf("a.pdf", "application/pdf", 10), fileOf("b.pdf", "application/pdf", 10)]);
    expect(h.c.files.map((f) => f.state)).toEqual(["refused", "uploading"]);
  });

  test("the upload to storage fails: upload_failed at once, and the server is told so the row is refused there", async () => {
    const h = harness();
    await h.c.add([fileOf("a.pdf", "application/pdf", 10)]);
    h.setList(() => ({ kind: "files", files: [row(fid(1), { name: "a.pdf", state: "refused", refusal: "upload_failed", sizeBytes: 10 })] }));
    h.uploads[0]!.finish("failed");
    await settle();
    await settle();
    expect(h.calls).toContain(`uploadFailed ${fid(1)}`);
    expect(h.c.files[0]).toMatchObject({ state: "refused", refusal: "upload_failed" });
    expect(h.c.busy).toBe(false);
  });

  test("Remove a file while it uploads: the upload is aborted, the server removes the row, the row leaves the list", async () => {
    const h = harness();
    await h.c.add([fileOf("a.pdf", "application/pdf", 10)]);
    const gate = deferred<RemoveFileResult>();
    h.setRemove(() => gate.promise);
    const removing = h.c.remove(fid(1));
    expect(h.uploads[0]!.aborted).toBe(true);
    expect(h.c.files[0]).toMatchObject({ removing: true });
    gate.resolve({ kind: "removed" });
    await removing;
    expect(h.calls).toContain(`remove ${fid(1)}`);
    expect(h.c.files).toEqual([]);
    // The aborted upload is not reported as a failure.
    await settle();
    expect(h.calls.filter((x) => x.startsWith("uploadFailed"))).toEqual([]);
  });

  test("Remove refused by the server: the row stays, Remove available again", async () => {
    const h = harness([row(fid(7), { state: "ready" })]);
    h.setRemove(() => ({ kind: "unavailable" }));
    await h.c.remove(fid(7));
    expect(h.c.files).toEqual([row(fid(7), { state: "ready" })]);
  });

  test("Remove before the add action answered: the file is removed on the server as soon as it exists, never uploaded", async () => {
    const h = harness();
    const gate = deferred<AddFileResult>();
    h.addReplies.push(() => gate.promise);
    const adding = h.c.add([fileOf("a.pdf", "application/pdf", 10)]);
    await settle();
    const local = h.c.files[0]!.id;
    await h.c.remove(local);
    expect(h.c.files).toEqual([]);
    gate.resolve({ kind: "added", file: row(fid(9)), upload: POST });
    await adding;
    await settle();
    expect(h.uploads).toEqual([]);
    expect(h.calls).toContain(`remove ${fid(9)}`);
    expect(h.c.files).toEqual([]);
  });

  test("Open: the tab is opened inside the click, before any await, then sent to the link with no opener", async () => {
    const h = harness([row(fid(3), { state: "ready" })]);
    await h.click(() => h.c.open(fid(3)));
    expect(h.tabs).toHaveLength(1);
    expect(h.tabs[0]!.openedSync).toBe(true);
    expect(h.tabs[0]!.opener).toBeNull();
    expect(h.tabs[0]!.location.href).toBe("https://storage.example/b/uploads/x?X-Amz-Expires=300");
  });

  test("Open with no link (another account, expired): the tab is closed", async () => {
    const h = harness([row(fid(3), { state: "ready" })]);
    h.setOpen(() => Promise.resolve({ url: null }));
    await h.click(() => h.c.open(fid(3)));
    expect(h.tabs[0]!.closed).toBe(true);
    h.setOpen(() => Promise.reject(new Error("Failed to fetch")));
    await h.click(() => h.c.open(fid(3)));
    expect(h.tabs[1]!.closed).toBe(true);
  });

  test("Refresh: the server's states replace the page's (checking → ready, refused with its reason); busy stops when nothing is pending", async () => {
    const h = harness([row(fid(1), { state: "checking" }), row(fid(2), { state: "checking", name: "notes.txt", mediaType: "text/plain" })]);
    expect(h.c.busy).toBe(true);
    h.setList(() => ({ kind: "files", files: [row(fid(1), { state: "ready" }), row(fid(2), { state: "refused", refusal: "malware", name: "notes.txt", mediaType: "text/plain" })] }));
    await h.c.refresh();
    expect(h.c.files.map((f) => [f.state, f.refusal])).toEqual([
      ["ready", undefined],
      ["refused", "malware"],
    ]);
    expect(h.c.busy).toBe(false);
  });

  test("Refresh while a file uploads: the progress is kept; once uploaded, a server row still 'uploading' shows as checking", async () => {
    const h = harness();
    await h.c.add([fileOf("a.pdf", "application/pdf", 10)]);
    h.uploads[0]!.onProgress(0.5);
    h.setList(() => ({ kind: "files", files: [row(fid(1), { name: "a.pdf", sizeBytes: 10 })] }));
    await h.c.refresh();
    expect(h.c.files[0]).toMatchObject({ state: "uploading", progress: 0.5 });
    h.uploads[0]!.finish("ok");
    await settle();
    await h.c.refresh();
    expect(h.c.files[0]).toMatchObject({ state: "checking" });
  });

  test("Refresh keeps local refusals in place and never brings back a file removed meanwhile", async () => {
    const h = harness([row(fid(1), { state: "ready" })]);
    h.addReplies.push(() => ({ kind: "refused", refusal: "count" }));
    await h.c.add([fileOf("sixth.pdf", "application/pdf", 1)]);
    await h.c.remove(fid(1));
    // A list read before the removal was recorded still names the file.
    h.setList(() => ({ kind: "files", files: [row(fid(1), { state: "ready" })] }));
    await h.c.refresh();
    expect(h.c.files.map((f) => f.name)).toEqual(["sixth.pdf"]);
  });

  test("Refresh unavailable (link expired meanwhile): the page keeps what it shows", async () => {
    const h = harness([row(fid(1), { state: "checking" })]);
    h.setList(() => ({ kind: "unavailable" }));
    await h.c.refresh();
    expect(h.c.files).toEqual([row(fid(1), { state: "checking" })]);
  });

  test("every change is reported to the page", async () => {
    const h = harness();
    await h.c.add([fileOf("a.pdf", "application/pdf", 10)]);
    expect(h.seen.length).toBeGreaterThanOrEqual(2);
    expect(h.seen.at(-1)).toEqual(h.c.files);
  });
});

describe("xhrUploader: the browser's POST to storage", () => {
  class FakeXHR {
    static last: FakeXHR;
    method = "";
    url = "";
    body: FormData | undefined;
    status = 0;
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    constructor() {
      FakeXHR.last = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    send(body: FormData) {
      this.body = body;
    }
    abort() {
      this.onabort?.();
    }
  }

  test("posts the policy's fields, then the file last, to the storage URL; progress as a fraction; 2xx is ok", async () => {
    const progress: number[] = [];
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    const h = xhrUploader(FakeXHR as never)({ upload: POST, file, onProgress: (p) => progress.push(p) });
    const x = FakeXHR.last;
    expect(x.method).toBe("POST");
    expect(x.url).toBe(POST.url);
    expect([...x.body!.keys()]).toEqual(["key", "Content-Type", "Policy", "file"]);
    expect(x.body!.get("Content-Type")).toBe("application/pdf");
    x.upload.onprogress!({ lengthComputable: true, loaded: 21, total: 50 });
    x.upload.onprogress!({ lengthComputable: false, loaded: 0, total: 0 });
    expect(progress).toEqual([0.42]);
    x.status = 204;
    x.onload!();
    expect(await h.done).toBe("ok");
  });

  test("a refusal by storage (403, 400), a network error or a timeout is a failed upload; abort is aborted", async () => {
    const file = new File(["x"], "a.txt");
    for (const end of [(x: FakeXHR) => ((x.status = 403), x.onload!()), (x: FakeXHR) => ((x.status = 400), x.onload!()), (x: FakeXHR) => x.onerror!(), (x: FakeXHR) => x.ontimeout!()]) {
      const h = xhrUploader(FakeXHR as never)({ upload: POST, file, onProgress: () => {} });
      end(FakeXHR.last);
      expect(await h.done).toBe("failed");
    }
    const h = xhrUploader(FakeXHR as never)({ upload: POST, file, onProgress: () => {} });
    h.abort();
    expect(await h.done).toBe("aborted");
  });
});
