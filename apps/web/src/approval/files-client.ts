// The approval page's files in the browser (m2-attachments task 5.2, design
// D2, D6; design.md F0–F12). No React here: the page's component holds a
// `FilesController` and re-renders on `onChange`. It keeps `files` current
// for `ApprovalScreen`, which announces, gates Send and moves focus by itself.
//
// - Add: one server action call per file, in order (the server checks the
//   limits under the request's lock); the row shows at once; the file then
//   goes straight to storage through the presigned POST, with progress. A
//   file refused before storing stays as a local row with its reason until
//   the principal removes it.
// - Remove: aborts an upload in progress, then asks the server.
// - Open: the tab is opened inside the click (a tab opened after an await
//   is blocked as a pop-up), then sent to the 5-minute link, with no opener.
//   The page itself never navigates, so edits to the question survive.
// - Refresh: the server's states replace the page's while files upload or
//   are checked (`busy`); the page polls only while `busy`.
// Nothing here logs, and nothing reads a file's content.
import type { ApprovalFile } from "@a2h/ui";
import type { AddFileResult, FilesResult, OpenFileResult, RemoveFileResult } from "./files";

export interface FileActions {
  add(file: { name: string; type: string; size: number }): Promise<AddFileResult>;
  remove(id: string): Promise<RemoveFileResult>;
  open(id: string): Promise<OpenFileResult>;
  list(): Promise<FilesResult>;
  uploadFailed(id: string): Promise<FilesResult>;
}

export type UploadOutcome = "ok" | "failed" | "aborted";
export interface UploadHandle {
  done: Promise<UploadOutcome>;
  abort(): void;
}
export type Uploader = (i: { upload: { url: string; fields: Record<string, string> }; file: Blob; onProgress: (fraction: number) => void }) => UploadHandle;

/** What the controller needs of a browser tab. */
export interface Tab {
  opener: unknown;
  location: { href: string };
  close(): void;
}

const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  markdown: "text/markdown",
};
const ALLOWED = new Set(Object.values(BY_EXTENSION));
/** Types browsers give files of an allowed kind (or none at all, often for Markdown). */
const MISLABELS = new Set(["", "text/x-markdown", "application/vnd.ms-excel", "text/x-csv", "application/csv"]);

/**
 * The type to declare for the upload policy: the browser's when allowed;
 * from the extension when the browser gave none or a known mislabel;
 * otherwise as given (the server refuses it). The worker reads the bytes
 * and refuses any file whose content disagrees (D3).
 */
export function declaredType(file: { name: string; type: string }): string {
  if (ALLOWED.has(file.type)) return file.type;
  if (MISLABELS.has(file.type)) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase();
    const byExt = ext !== undefined ? BY_EXTENSION[ext] : undefined;
    if (byExt !== undefined) return byExt;
  }
  return file.type;
}

/** The browser's POST to storage with progress (fetch has no upload progress). */
export function xhrUploader(XHR?: typeof XMLHttpRequest): Uploader {
  return ({ upload, file, onProgress }) => {
    // Resolved at upload time: the page's first render runs on the server, which has no XMLHttpRequest.
    const xhr = new (XHR ?? XMLHttpRequest)();
    const done = new Promise<UploadOutcome>((resolve) => {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300 ? "ok" : "failed");
      xhr.onerror = () => resolve("failed");
      xhr.ontimeout = () => resolve("failed");
      xhr.onabort = () => resolve("aborted");
    });
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
    // S3 reads the fields before the file: the file is the last part.
    form.append("file", file);
    xhr.open("POST", upload.url);
    xhr.send(form);
    return { done, abort: () => xhr.abort() };
  };
}

interface Entry {
  file: ApprovalFile;
  /** No server row: refused before storing, or the add action has not answered yet. */
  local: boolean;
  pendingAdd?: boolean;
  /** Removed while its add was pending: remove it on the server once it exists. */
  cancelled?: boolean;
  upload?: UploadHandle | undefined;
  uploaded?: boolean;
}

export interface FilesControllerOptions {
  actions: FileActions;
  upload: Uploader;
  /** `window.open("about:blank", "_blank")`, called synchronously in the click. */
  openTab: () => Tab | null;
  onChange: (files: readonly ApprovalFile[]) => void;
  initial: readonly ApprovalFile[];
}

const PENDING = new Set(["uploading", "checking"]);

/** The row without the page's transient marks (progress, removing). */
function bare(f: ApprovalFile): ApprovalFile {
  const out = { ...f };
  delete out.progress;
  delete out.removing;
  return out;
}

export class FilesController {
  #o: FilesControllerOptions;
  #entries: Entry[];
  #files: readonly ApprovalFile[] = [];
  #removed = new Set<string>();
  #adds = 0;
  #local = 0;
  #refreshing: Promise<void> | undefined;

  constructor(o: FilesControllerOptions) {
    this.#o = o;
    this.#entries = o.initial.map((file) => ({ file, local: false }));
    this.#files = this.#entries.map((e) => e.file);
  }

  get files(): readonly ApprovalFile[] {
    return this.#files;
  }

  /** A file is uploading or being checked: the page refreshes until none is. */
  get busy(): boolean {
    return this.#files.some((f) => PENDING.has(f.state));
  }

  #emit(): void {
    this.#files = this.#entries.map((e) => e.file);
    this.#o.onChange(this.#files);
  }

  #find(id: string): Entry | undefined {
    return this.#entries.find((e) => e.file.id === id);
  }

  #drop(entry: Entry): void {
    this.#entries = this.#entries.filter((e) => e !== entry);
  }

  async add(files: readonly File[]): Promise<void> {
    for (const file of files) await this.#addOne(file);
  }

  async #addOne(file: File): Promise<void> {
    this.#local += 1;
    const type = declaredType(file);
    const entry: Entry = {
      file: { id: `local-${this.#local}`, name: file.name, mediaType: type, sizeBytes: file.size, state: "uploading" },
      local: true,
      pendingAdd: true,
    };
    this.#entries.push(entry);
    this.#emit();
    this.#adds += 1;
    let r: AddFileResult;
    try {
      r = await this.#o.actions.add({ name: file.name, type, size: file.size });
    } catch {
      r = { kind: "unavailable" };
    } finally {
      this.#adds -= 1;
    }
    entry.pendingAdd = false;
    if (entry.cancelled) {
      if (r.kind === "added") {
        this.#removed.add(r.file.id);
        await this.#o.actions.remove(r.file.id).catch(() => undefined);
      }
      return;
    }
    if (r.kind === "refused") {
      entry.file = { ...entry.file, state: "refused", refusal: r.refusal };
    } else if (r.kind === "unavailable") {
      entry.file = { ...entry.file, state: "refused", refusal: "upload_failed" };
    } else {
      entry.local = false;
      entry.file = r.file;
      this.#startUpload(entry, r.upload, file);
    }
    this.#emit();
  }

  #startUpload(entry: Entry, upload: { url: string; fields: Record<string, string> }, file: Blob): void {
    const handle = this.#o.upload({
      upload,
      file,
      onProgress: (p) => {
        if (entry.file.state !== "uploading") return;
        entry.file = { ...entry.file, progress: p };
        this.#emit();
      },
    });
    entry.upload = handle;
    void handle.done.then(async (outcome) => {
      entry.upload = undefined;
      if (outcome === "aborted" || !this.#entries.includes(entry)) return;
      if (outcome === "ok") {
        entry.uploaded = true;
        if (entry.file.state === "uploading") {
          entry.file = { ...bare(entry.file), state: "checking" };
          this.#emit();
        }
        return;
      }
      entry.file = { ...bare(entry.file), state: "refused", refusal: "upload_failed" };
      this.#emit();
      const r = await this.#o.actions.uploadFailed(entry.file.id).catch((): FilesResult => ({ kind: "unavailable" }));
      if (r.kind === "files") this.#merge(r.files);
    });
  }

  async remove(id: string): Promise<void> {
    const entry = this.#find(id);
    if (!entry || entry.file.removing) return;
    if (entry.local) {
      if (entry.pendingAdd) entry.cancelled = true;
      this.#drop(entry);
      this.#emit();
      return;
    }
    entry.file = { ...entry.file, removing: true };
    this.#emit();
    const wasUploading = entry.upload !== undefined;
    entry.upload?.abort();
    let r: RemoveFileResult;
    try {
      r = await this.#o.actions.remove(id);
    } catch {
      r = { kind: "unavailable" };
    }
    if (r.kind === "removed") {
      this.#removed.add(id);
      this.#drop(entry);
    } else {
      const rest = bare(entry.file);
      // An upload aborted for a removal that then failed did not finish.
      entry.file = wasUploading && rest.state === "uploading" ? { ...rest, state: "refused", refusal: "upload_failed" } : rest;
    }
    this.#emit();
  }

  /** Call from the click handler itself: the tab is opened before the first await. */
  async open(id: string): Promise<void> {
    const tab = this.#o.openTab();
    let r: OpenFileResult;
    try {
      r = await this.#o.actions.open(id);
    } catch {
      r = { url: null };
    }
    if (!tab) return;
    if (r.url === null) {
      tab.close();
      return;
    }
    tab.opener = null;
    tab.location.href = r.url;
  }

  /** The server's states, one call at a time. */
  refresh(): Promise<void> {
    this.#refreshing ??= (async () => {
      try {
        const r = await this.#o.actions.list().catch((): FilesResult => ({ kind: "unavailable" }));
        if (r.kind === "files") this.#merge(r.files);
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  #merge(server: readonly ApprovalFile[]): void {
    const byId = new Map(server.map((f) => [f.id, f]));
    const next: Entry[] = [];
    for (const e of this.#entries) {
      if (e.local) {
        next.push(e);
        continue;
      }
      const s = byId.get(e.file.id);
      if (!s || this.#removed.has(e.file.id)) continue;
      let file: ApprovalFile = s;
      if (s.state === "uploading" && e.upload !== undefined) file = e.file;
      else if (s.state === "uploading" && e.uploaded) file = { ...s, state: "checking" };
      else if (s.state === "uploading" && e.file.state === "refused") file = e.file;
      if (e.file.removing) file = { ...file, removing: true };
      e.file = file;
      next.push(e);
    }
    if (this.#adds === 0) {
      const known = new Set(next.map((e) => e.file.id));
      for (const s of server) if (!known.has(s.id) && !this.#removed.has(s.id)) next.push({ file: s, local: false });
    }
    this.#entries = next;
    this.#emit();
  }

  /** The page is leaving the form: stop uploads in progress. */
  dispose(): void {
    for (const e of this.#entries) e.upload?.abort();
  }
}
