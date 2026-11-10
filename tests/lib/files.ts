// Files on the approval page, for the live suites (m2-attachments tasks 6.1
// to 6.3): fixtures, the page's file controls, what a stage offers (storage,
// checks), and two instruments the adversarial cases need: the upload policy
// the page's add action returned, and a replay of the page's own server
// actions with other arguments.
//
// Fixtures (6.3): the small ones are committed under tests/fixtures/files/ (the ZIP is built here: *.zip is ignored)
// (each under 1 KB); anything large is generated here; the EICAR test string
// is built from parts at run time (local/fake-scanner.ts `eicar`), never
// committed whole.
//
// What a stage must offer, and what happens when it does not (the same rule
// as apps/web/test/e2e/files.spec.ts):
// - storage: the bucket's CORS for the stage's web origin (POST). Without it
//   the browser's upload fails ("The upload did not finish") and the test is
//   skipped with that reason, unless A2H_E2E_REQUIRE_FILE_STORAGE=1 (then it
//   fails).
// - checks: the worker's content check and a scan result (GuardDuty on a
//   deployed stage, local/fake-scanner.ts on the local stage). Without a
//   result within CHECK_WAIT_MS the test is skipped, unless
//   A2H_E2E_REQUIRE_FILE_CHECKS=1 (then it fails).
// Nothing here prints a file's bytes, a link, a policy or a token.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page, Request } from "@playwright/test";
import { eicar, SCAN_CONTROL_PREFIX } from "../local/fake-scanner.ts";

export { eicar };

export const MB = 1024 * 1024;
export const KB = 1024;
export const REQUIRE_STORAGE = process.env["A2H_E2E_REQUIRE_FILE_STORAGE"] === "1";
export const REQUIRE_CHECKS = process.env["A2H_E2E_REQUIRE_FILE_CHECKS"] === "1";
/** How long a file may stay "Checking" before the stage is taken to have no check (a scan takes seconds). */
export const CHECK_WAIT_MS = Number(process.env["A2H_FILE_CHECK_WAIT_MS"] ?? 150_000);

/**
 * The verify jobs run the file suites in a step of their own ("File flows",
 * A2H_FILE_STEP=1) and set A2H_FILE_SUITES=own-step for the whole job, so the
 * general contract and adversarial steps skip them. By hand: they run.
 */
export const ELSEWHERE: string | false =
  process.env["A2H_FILE_SUITES"] === "own-step" && process.env["A2H_FILE_STEP"] !== "1" ? "runs in the verify job's own step (File flows: pnpm --filter @a2h/tests files)" : false;

export const NO_STORAGE = "uploads to storage are not available on this stage (the bucket has no POST CORS for this origin until dev deploys m2-attachments from main)";
export const NO_CHECKS = "files are not checked on this stage (no scan result arrived: the scanner and S3 → EventBridge come with dev's deploy of m2-attachments from main)";

export interface FileInput {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const FIXTURES = fileURLToPath(new URL("../fixtures/files/", import.meta.url));
const fixture = (file: string): Buffer => readFileSync(`${FIXTURES}${file}`);

/** The committed fixtures (task 6.3), by the name the tests give them. Each under 1 KB. */
export const F = {
  pdf: (): FileInput => ({ name: "leaflet.pdf", mimeType: "application/pdf", buffer: fixture("leaflet.pdf") }),
  png: (): FileInput => ({ name: "chart.png", mimeType: "image/png", buffer: fixture("chart.png") }),
  jpeg: (): FileInput => ({ name: "IMG_2041.jpg", mimeType: "image/jpeg", buffer: fixture("photo.jpg") }),
  webp: (): FileInput => ({ name: "diagram.webp", mimeType: "image/webp", buffer: fixture("diagram.webp") }),
  text: (): FileInput => ({ name: "notes-clean.txt", mimeType: "text/plain", buffer: fixture("notes.txt") }),
  csv: (): FileInput => ({ name: "figures.csv", mimeType: "text/csv", buffer: fixture("figures.csv") }),
  markdown: (): FileInput => ({ name: "summary.md", mimeType: "text/markdown", buffer: fixture("summary.md") }),
  /** An HTML document named and declared as a PDF (spec "Name and content disagree"). */
  disguisedHtml: (): FileInput => ({ name: "report.pdf", mimeType: "application/pdf", buffer: fixture("report-html.pdf") }),
  /** An empty ZIP archive (its end-of-central-directory record), built here: the repository ignores *.zip. */
  zip: (): FileInput => ({ name: "bundle.zip", mimeType: "application/zip", buffer: Buffer.concat([Buffer.from("PK\x05\x06", "latin1"), Buffer.alloc(18)]) }),
  exe: (): FileInput => ({ name: "setup.exe", mimeType: "application/x-msdownload", buffer: fixture("setup.exe") }),
  /** The EICAR test string in a file named notes.txt (spec "Malicious file"); built at run time. */
  eicar: (): FileInput => ({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(eicar(), "latin1") }),
};

/** A PDF of exactly `size` bytes: a valid header, then a comment padded to size, then the trailer. */
export function pdfOfSize(size: number, name = "minutes.pdf"): FileInput {
  const head = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%");
  const tail = Buffer.from("\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
  assert.ok(size > head.length + tail.length);
  return { name, mimeType: "application/pdf", buffer: Buffer.concat([head, Buffer.alloc(size - head.length - tail.length, 0x41), tail]) };
}

/** A PNG of exactly `size` bytes: the committed 1×1 image, then padding after IEND (readers stop at IEND). */
export function pngOfSize(size: number, name = "chart.png"): FileInput {
  const png = fixture("chart.png");
  assert.ok(size >= png.length);
  return { name, mimeType: "image/png", buffer: Buffer.concat([png, Buffer.alloc(size - png.length, 0)]) };
}

/** Plain UTF-8 text of exactly `size` bytes. */
export function textOfSize(size: number, name = "transcript.txt"): FileInput {
  const line = "The quick brown fox jumps over the lazy dog.\n";
  return { name, mimeType: "text/plain", buffer: Buffer.from(line.repeat(Math.ceil(size / line.length)).slice(0, size), "utf8") };
}

// ---- the page's file controls (design.md F0–F15; packages/ui copy.approval.files) ----

export const files = {
  choose: (page: Page) => page.getByRole("button", { name: "Choose files" }),
  list: (page: Page) => page.getByRole("list", { name: "Files they will consult" }),
  sentList: (page: Page) => page.getByRole("list", { name: "Files sent with it" }),
  row: (page: Page, name: string) => page.getByRole("listitem").filter({ hasText: name }),
  remove: (page: Page, name: string) => page.getByRole("button", { name: `Remove ${name}`, exact: true }),
  open: (page: Page, name: string) => page.getByRole("button", { name: `Open ${name}`, exact: true }),
  announcer: (page: Page) => page.locator("section[aria-labelledby='request-files'] [role='status']"),
};

export const COPY = {
  uploadFailed: "The upload did not finish.",
  refusedType: "This type of file can't be sent.",
  refusedSize: "This file is over 25 MB, the most for one file.",
  refusedTotal: "With this file the request would be over 50 MB, the most for all files together.",
  refusedCount: "A request can have 5 files at most.",
  refusedMalware: "The security check refused this file, so it has been deleted.",
  refusedNotChecked: "This file couldn't be checked, so it can't be sent.",
  gateChecking: "Files are being checked. Send will be available when every file is ready.",
  gateUploading: "Files are uploading. Send will be available when every file is ready.",
  rulesTitle: "It doesn't fit their rules",
  notReadyTitle: "A file isn't ready yet",
} as const;

/** Through the system picker, as a person would. */
export async function addFiles(page: Page, list: FileInput[]): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await files.choose(page).click();
  await (await chooser).setFiles(list);
}

export type Pill = "Uploading" | "Checking" | "Ready" | "Refused";

/** The state pill of a row ("Uploading 40 %" reads as Uploading). */
export async function pillOf(page: Page, name: string): Promise<Pill | undefined> {
  const text = (await files.row(page, name).first().innerText().catch(() => "")) ?? "";
  for (const p of ["Refused", "Ready", "Checking", "Uploading"] as const) if (new RegExp(`(^|\\n)${p}`).test(text)) return p;
  return undefined;
}

export async function rowText(page: Page, name: string): Promise<string> {
  return (await files.row(page, name).first().innerText().catch(() => "")).trim();
}

/** Polls until `probe` returns a value, or fails after `boundMs` with `what`. */
async function poll<T>(what: string, boundMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + boundMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(boundMs / 1000)} s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** What the stage did with an upload, as the page shows it. */
export type Outcome = { kind: "skip"; reason: string } | { kind: "pill"; pill: Pill; text: string };

/**
 * Waits until the browser's upload of `name` ended. "skip" when storage
 * refused it (no CORS yet) and storage is not required; fails when it is.
 */
export async function afterUpload(page: Page, name: string): Promise<Outcome> {
  const pill = await poll(`the upload of a file to end (${name.length} chars)`, 90_000, async () => {
    const p = await pillOf(page, name);
    return p && p !== "Uploading" ? p : undefined;
  });
  const text = await rowText(page, name);
  if (pill === "Refused" && text.includes(COPY.uploadFailed)) {
    assert.ok(!REQUIRE_STORAGE, "the browser's upload to storage failed and A2H_E2E_REQUIRE_FILE_STORAGE=1");
    return { kind: "skip", reason: NO_STORAGE };
  }
  return { kind: "pill", pill, text };
}

/**
 * Waits until `name` is Ready or Refused (the check's outcome). "skip" when
 * the upload never reached storage, or no result came within CHECK_WAIT_MS,
 * and the stage is not required to offer them.
 */
export async function afterCheck(page: Page, name: string, waitMs = CHECK_WAIT_MS): Promise<Outcome> {
  const up = await afterUpload(page, name);
  if (up.kind === "skip" || up.pill !== "Checking") return up;
  try {
    const pill = await poll(`the check of a file to end`, waitMs, async () => {
      const p = await pillOf(page, name);
      return p === "Ready" || p === "Refused" ? p : undefined;
    });
    return { kind: "pill", pill, text: await rowText(page, name) };
  } catch (e) {
    if (REQUIRE_CHECKS) throw new Error(`no check result within ${Math.round(waitMs / 1000)} s and A2H_E2E_REQUIRE_FILE_CHECKS=1`, { cause: e });
    return { kind: "skip", reason: NO_CHECKS };
  }
}

// ---- instruments for the adversarial cases ---------------------------------------

export interface UploadPolicy {
  url: string;
  fields: Record<string, string>;
}

export interface CapturedAction {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * The answer of a server action, from its React Flight response: rows
 * `<hex id>:<json>\n`, and text rows `<hex id>:T<hex byte length>,<text>`
 * (no newline after them) for long strings, which the JSON rows reference as
 * "$<hex id>" ("$$" escapes a string starting with "$"). A deployed stage's
 * upload policy carries a session token and is long enough to be sent that
 * way. Returns the last object row with `kind` or `url`, references resolved.
 */
export function actionResult(text: string): Record<string, unknown> | undefined {
  const bytes = Buffer.from(text, "utf8");
  const rows = new Map<string, unknown>();
  const texts = new Map<string, string>();
  let out: Record<string, unknown> | undefined;
  let i = 0;
  while (i < bytes.length) {
    const colon = bytes.indexOf(0x3a, i);
    if (colon < 0) break;
    const id = bytes.subarray(i, colon).toString("latin1");
    if (!/^[0-9a-f]+$/.test(id)) {
      const nl = bytes.indexOf(0x0a, i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (bytes[colon + 1] === 0x54 /* T */) {
      const comma = bytes.indexOf(0x2c, colon);
      const length = parseInt(bytes.subarray(colon + 2, comma).toString("latin1"), 16);
      texts.set(id, bytes.subarray(comma + 1, comma + 1 + length).toString("utf8"));
      i = comma + 1 + length;
      continue;
    }
    let nl = bytes.indexOf(0x0a, colon);
    if (nl < 0) nl = bytes.length;
    try {
      rows.set(id, JSON.parse(bytes.subarray(colon + 1, nl).toString("utf8")));
    } catch {
      // not a JSON row
    }
    i = nl + 1;
  }
  const resolve = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$")) {
      if (v.startsWith("$$")) return v.slice(1);
      const ref = v.slice(1);
      if (texts.has(ref)) return texts.get(ref);
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  for (const v of rows.values()) {
    if (v && typeof v === "object" && !Array.isArray(v) && ("kind" in v || "url" in v)) out = resolve(v) as Record<string, unknown>;
  }
  return out;
}

/** The page's add action for the file named `name` (arguments: request id, { name, type, size }). */
export const addOf = (name: string) => (args: unknown[]) => args.length === 2 && (args[1] as { name?: unknown } | null)?.name === name;
/** The page's remove, open or upload-failed action for file `id` (arguments: request id, file id). */
export const fileActionOf = (id: string) => (args: unknown[]) => args.length === 2 && args[1] === id;

const isAction = (r: Request) => r.method() === "POST" && r.headers()["next-action"] !== undefined;

/** Runs `trigger` and returns the first server-action call it causes whose arguments pass `match`, with its result. */
export async function captureAction(
  page: Page,
  match: (args: unknown[]) => boolean,
  trigger: () => Promise<void>,
): Promise<{ action: CapturedAction; args: unknown[]; result: Record<string, unknown> | undefined }> {
  // Through a route, so that the response body is read on the way (Chromium may not keep it for later).
  let done = false;
  let resolve!: (v: { request: Request; text: string }) => void;
  const seen = new Promise<{ request: Request; text: string }>((r) => (resolve = r));
  const pattern = (url: URL) => url.pathname.startsWith("/approve/");
  const handler = async (route: import("@playwright/test").Route) => {
    const r = route.request();
    let args: unknown;
    try {
      args = isAction(r) ? (JSON.parse(r.postData() ?? "") as unknown) : undefined;
    } catch {
      args = undefined;
    }
    if (done || !Array.isArray(args) || !match(args)) return route.fallback();
    done = true;
    const response = await route.fetch();
    const text = await response.text();
    await route.fulfill({ response, body: text });
    resolve({ request: r, text });
  };
  await page.route(pattern, handler);
  try {
    await trigger();
    const { request, text } = await Promise.race([
      seen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no matching server action within 60 s")), 60_000)),
    ]);
    const headers = await request.allHeaders();
    const keep: Record<string, string> = {};
    for (const h of ["next-action", "next-router-state-tree", "content-type", "accept"]) if (headers[h] !== undefined) keep[h] = headers[h];
    return { action: { url: request.url(), headers: keep, body: request.postData() ?? "" }, args: JSON.parse(request.postData() ?? "[]") as unknown[], result: actionResult(text) };
  } finally {
    await page.unroute(pattern, handler);
  }
}

/**
 * Calls a captured server action again from `page`'s context (its cookies:
 * the session, and the approval cookie of the path posted to) with other
 * arguments, at `path` (default the captured page). Returns its result.
 */
export async function replayAction(page: Page, action: CapturedAction, args: unknown[], path?: string): Promise<Record<string, unknown> | undefined> {
  const url = path ? new URL(path, action.url).toString() : action.url;
  const res = await page.request.post(url, { headers: action.headers, data: JSON.stringify(args), failOnStatusCode: false, maxRedirects: 0 });
  return actionResult(await res.text());
}

/**
 * Lets the page believe its upload to storage succeeded, without sending it:
 * the test then posts whatever body it wants with the policy (`postToStorage`).
 * Returns a function that removes the stand-in.
 */
export async function holdBrowserUploads(page: Page, webOrigin: string): Promise<() => Promise<void>> {
  const handler = async (route: import("@playwright/test").Route) => {
    const r = route.request();
    if (r.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": webOrigin, "access-control-allow-methods": "POST", "access-control-allow-headers": "*" } });
      return;
    }
    if (r.method() === "POST" && !r.url().startsWith(webOrigin)) {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": webOrigin } });
      return;
    }
    await route.fallback();
  };
  const pattern = (url: URL) => !url.toString().startsWith(webOrigin);
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

/** POSTs `body` to storage with an upload policy's fields, as a browser form would (fields first, then the file). */
export async function postToStorage(policy: UploadPolicy, body: Buffer, overrides: Record<string, string> = {}): Promise<{ status: number; code: string | undefined }> {
  const form = new FormData();
  for (const [k, v] of Object.entries({ ...policy.fields, ...overrides })) form.append(k, v);
  form.append("file", new Blob([new Uint8Array(body)]));
  const res = await fetch(policy.url, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  return { status: res.status, code: /<Code>([^<]+)<\/Code>/.exec(text)?.[1] };
}

/** An unsigned GET of `key` in the bucket the policy names: what a guess at an address gets. */
export async function guessObject(policy: UploadPolicy, key: string): Promise<number> {
  const base = policy.url.endsWith("/") ? policy.url : `${policy.url}/`;
  const res = await fetch(`${base}${key}`, { signal: AbortSignal.timeout(30_000) });
  await res.arrayBuffer();
  return res.status;
}

/**
 * An action's answer as an assertion may print it: no policy, signature or
 * link ever reaches a log (the repository and its CI logs are public).
 */
export function redact(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!result) return result;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === "upload") out[k] = "<an upload policy>";
    else if (k === "url") out[k] = typeof v === "string" ? "<a link>" : v;
    else if (k === "file") out[k] = { state: (v as { state?: unknown } | null)?.state };
    else if (k === "files") out[k] = Array.isArray(v) ? `<${v.length} files>` : v;
    else out[k] = v;
  }
  return out;
}

/** The add action's answer for a file: the policy when added. */
export function policyOf(result: Record<string, unknown> | undefined): UploadPolicy | undefined {
  const upload = result?.["upload"] as UploadPolicy | undefined;
  return upload && typeof upload.url === "string" ? upload : undefined;
}

export function fileIdOf(result: Record<string, unknown> | undefined): string | undefined {
  return (result?.["file"] as { id?: string } | undefined)?.id;
}

// ---- the local stage's storage (A2H_LOCAL_S3_ENDPOINT): objects seen directly ----

/** Set when the suites run against the local stage with files (local/stage.ts A2H_LOCAL_FILES=1). */
export const LOCAL_S3 = process.env["A2H_LOCAL_S3_ENDPOINT"]?.trim() || undefined;

/**
 * The keys stored for a request in both areas, on the local stage only
 * (undefined elsewhere: a deployed stage's bucket is not readable from the
 * verify job, and the deletion is proven there through the principal's own
 * links and by apps/worker/test/files.test.ts).
 */
export async function localObjects(requestId: string): Promise<string[] | undefined> {
  if (!LOCAL_S3) return undefined;
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const { s3, bucket, prefix } = await localS3(LOCAL_S3);
  const keys: string[] = [];
  for (const area of ["tmp", "uploads"]) {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${area}/${prefix}files/${requestId}/` }));
    for (const o of out.Contents ?? []) keys.push(o.Key!);
  }
  s3.destroy();
  return keys;
}

async function localS3(endpoint: string) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ endpoint, forcePathStyle: true, region: "eu-west-3", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  return { s3, bucket: process.env["A2H_LOCAL_UPLOADS_BUCKET"] ?? "a2h-uploads-local", prefix: process.env["A2H_LOCAL_STORAGE_PREFIX"] ?? "pr-12/" };
}

/** The bytes of a file's object in one area, on the local stage only (undefined when there is none). */
export async function localObjectBytes(area: "tmp" | "uploads", requestId: string, fileId: string): Promise<Buffer | undefined> {
  if (!LOCAL_S3) return undefined;
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { s3, bucket, prefix } = await localS3(LOCAL_S3);
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${area}/${prefix}files/${requestId}/${fileId}` }));
    return Buffer.from(await out.Body!.transformToByteArray());
  } catch {
    return undefined;
  } finally {
    s3.destroy();
  }
}

/**
 * The fake scanner's hold control (local/fake-scanner.ts), on the local
 * stage only: "hold" before the file's first POST keeps every verdict on it
 * back; "release" lets them go, in the order their versions were scanned.
 */
export async function scanControl(kind: "hold" | "release", fileId: string): Promise<void> {
  assert.ok(LOCAL_S3, "the scan hold is a local-stage control");
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { s3, bucket } = await localS3(LOCAL_S3);
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${SCAN_CONTROL_PREFIX}${kind}/${fileId}`, Body: new Uint8Array(0), ContentLength: 0 }));
  } finally {
    s3.destroy();
  }
}

/** The local stage's log files (A2H_LOCAL_LOG_FILES, comma-separated): what the worker and the fake scanner did. */
export const LOCAL_LOG_FILES = (process.env["A2H_LOCAL_LOG_FILES"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Waits for a stage log line (the JSON after its `worker ` or `mcp ` tag) carrying every field of `fields`; returns it. */
export async function localLogLine(what: string, fields: Record<string, string>, boundMs = 60_000): Promise<Record<string, unknown>> {
  assert.ok(LOCAL_LOG_FILES.length > 0, "needs A2H_LOCAL_LOG_FILES");
  return poll(what, boundMs, () => {
    for (const file of LOCAL_LOG_FILES) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const raw of text.split("\n")) {
        const at = raw.indexOf("{");
        if (at < 0) continue;
        let line: Record<string, unknown>;
        try {
          line = JSON.parse(raw.slice(at)) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (Object.entries(fields).every(([k, v]) => line[k] === v)) return Promise.resolve(line);
      }
    }
    return Promise.resolve(undefined);
  });
}

/** GET a link as a browser tab would: the status, the body, and S3's error code and message, if any. */
export async function fetchLink(url: string): Promise<{ status: number; body: Buffer; code: string | undefined; message: string | undefined }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = Buffer.from(await res.arrayBuffer());
  const text = res.ok ? "" : body.toString("utf8");
  return { status: res.status, body, code: /<Code>([^<]+)<\/Code>/.exec(text)?.[1], message: /<Message>([^<]+)<\/Message>/.exec(text)?.[1] };
}

/** Clicks Open on `name` and returns the link the new tab was pointed at (the tab is closed). */
export async function openedLink(page: Page, name: string): Promise<string> {
  // The tab's first request to storage: a PDF or text link downloads, so the tab never "loads" it.
  const request = page.context().waitForEvent("request", { predicate: (r) => r.url().includes("X-Amz-Signature"), timeout: 30_000 });
  const popup = page.waitForEvent("popup", { timeout: 30_000 });
  await files.open(page, name).click();
  const url = (await request).url();
  await (await popup).close().catch(() => undefined);
  return url;
}
