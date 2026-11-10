// In-memory stand-ins for the file jobs' outside world (m2-attachments task
// 3.2): an object store and a source of file events (objects created, scan
// results). They let the whole file path run locally and in tests without
// S3, GuardDuty or SQS: a test or a local run emits the events a scanner would.
import { createHash } from "node:crypto";
import type { FileEvent, FileEventSource } from "./events.ts";
import type { FileStore, ObjectHead } from "./store.ts";

/** The ETag S3 gives a single-part upload (MD5 hex, unquoted): what MemoryFileStore reports. */
export function etagOf(content: Uint8Array): string {
  return createHash("md5").update(content).digest("hex");
}

export interface StoredObject {
  content: Uint8Array;
  content_type: string;
}

export class MemoryFileStore implements FileStore {
  readonly objects = new Map<string, StoredObject>();
  /** Test hook: runs inside `copy`, after the bytes are written. */
  onCopy: (() => Promise<void>) | undefined;
  /** Test hook: runs at the start of every `delete`, before the object goes. */
  beforeDelete: (() => Promise<void>) | undefined;
  /** Test hook: every delete fails while true. */
  failDeletes = false;

  put(key: string, content: Uint8Array, contentType: string): void {
    this.objects.set(key, { content, content_type: contentType });
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  get(key: string): StoredObject | undefined {
    return this.objects.get(key);
  }

  head(key: string, length: number): Promise<ObjectHead | null> {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { bytes: o.content.subarray(0, length), size: o.content.length, etag: etagOf(o.content) } : null);
  }

  async copy(from: string, to: string, contentType: string, ifMatch: string): Promise<"copied" | "changed"> {
    const o = this.objects.get(from);
    if (!o || etagOf(o.content) !== ifMatch) return "changed";
    this.objects.set(to, { content: o.content, content_type: contentType });
    if (this.onCopy) await this.onCopy();
    return "copied";
  }

  async delete(key: string): Promise<void> {
    if (this.beforeDelete) await this.beforeDelete();
    if (this.failDeletes) throw new Error("delete: storage unavailable");
    this.objects.delete(key);
  }
}

/** A file event source fed by hand: `emit` delivers one event to the worker, as SQS would. */
export class MemoryFileEvents implements FileEventSource {
  private handler: ((event: FileEvent) => Promise<void>) | undefined;

  start(onEvent: (event: FileEvent) => Promise<void>): void {
    this.handler = onEvent;
  }

  async emit(event: FileEvent): Promise<void> {
    if (!this.handler) throw new Error("file events: not started");
    await this.handler(event);
  }

  stop(): Promise<void> {
    this.handler = undefined;
    return Promise.resolve();
  }
}
