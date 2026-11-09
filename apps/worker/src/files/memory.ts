// In-memory stand-ins for the file jobs' outside world (m2-attachments task
// 3.2): an object store and a source of file events (objects created, scan
// results). They let the whole file path run locally and in tests without
// S3, GuardDuty or SQS: a test or a local run emits the events a scanner would.
import type { FileEvent, FileEventSource } from "./events.ts";
import type { FileStore, ObjectHead } from "./store.ts";

export interface StoredObject {
  content: Uint8Array;
  content_type: string;
}

export class MemoryFileStore implements FileStore {
  readonly objects = new Map<string, StoredObject>();
  /** Test hook: runs inside `copy`, after the bytes are written. */
  onCopy: (() => Promise<void>) | undefined;
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
    return Promise.resolve(o ? { bytes: o.content.subarray(0, length), size: o.content.length } : null);
  }

  async copy(from: string, to: string, contentType: string): Promise<void> {
    const o = this.objects.get(from);
    if (!o) throw new Error("copy: no such object");
    this.objects.set(to, { content: o.content, content_type: contentType });
    if (this.onCopy) await this.onCopy();
  }

  delete(key: string): Promise<void> {
    if (this.failDeletes) return Promise.reject(new Error("delete: storage unavailable"));
    this.objects.delete(key);
    return Promise.resolve();
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
