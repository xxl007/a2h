// What reaches the worker about files (ADR 0005 item 4), whatever carries it:
// an object was created in the upload area, or a scan finished. The SQS
// consumer in apps/worker/infra maps the provider's events to these, keeping
// only opaque ids and the outcome; MemoryFileEvents (memory.ts) feeds them by hand.
import type { FileScanResult } from "@a2h/protocol";

export type FileEvent =
  /** An object landed at `tmp/<prefix>files/<request_id>/<file_id>`: run the content check. */
  | { kind: "created"; file_id: string }
  /** The scanner's verdict on that object. */
  | { kind: "scanned"; result: FileScanResult };

export interface FileEventSource {
  /** Start delivering events; an event counts as handled once `onEvent` resolves. */
  start(onEvent: (event: FileEvent) => Promise<void>): void;
  stop(): Promise<void>;
}
