// Deployment adapter: file events from the stage's SQS queue (ADR 0005 item
// 4). The stage's EventBridge rule sends two kinds of events there, both for
// keys under `tmp/<STORAGE_PREFIX>files/`: S3 "Object Created" and GuardDuty
// "Malware Protection Object Scan Result". This is the only code that knows
// their shapes. It keeps the opaque file id and the outcome, and drops the
// detection name, the hash and the reasons (ADR 0005 item 5): only a plain
// status reason code of an `error` reaches a log line. Anything else (another
// stage's key, the uploads area, the scanner's validation object, other
// events) is acknowledged and ignored.
import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { parseFileObjectKey, type FileScanOutcome, type FileScanResult } from "@a2h/protocol";
import { errorFields } from "../src/error-log.ts";
import type { FileEvent, FileEventSource } from "../src/files/events.ts";
import type { Log, WorkerLogLine } from "../src/log.ts";
import { unquoteEtag } from "./s3-store.ts";

export interface FileEventsOptions {
  /** The uploads bucket (UPLOADS_BUCKET). */
  bucket: string;
  /** The stage's STORAGE_PREFIX. */
  storagePrefix: string;
}

export interface MappedEvent {
  event: FileEvent | null;
  /** What may be logged about it: ids, outcome, codes. */
  log: WorkerLogLine;
}

const OUTCOMES: Record<string, FileScanOutcome> = {
  NO_THREATS_FOUND: "clean",
  THREATS_FOUND: "threat",
  UNSUPPORTED: "error",
  ACCESS_DENIED: "error",
  FAILED: "error",
};

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function ignored(why: string): MappedEvent {
  return { event: null, log: { msg: "file event ignored", why } };
}

/** One SQS message body (an EventBridge event) → a FileEvent of this stage, or null. */
export function fileEventOf(body: string, { bucket, storagePrefix }: FileEventsOptions): MappedEvent {
  let e: Json | undefined;
  try {
    e = obj(JSON.parse(body));
  } catch {
    return ignored("unparseable");
  }
  if (!e) return ignored("unparseable");
  const detail = obj(e["detail"]) ?? {};
  const source = str(e["source"]);
  const type = str(e["detail-type"]);

  if (source === "aws.s3" && type === "Object Created") {
    if (str(obj(detail["bucket"])?.["name"]) !== bucket) return ignored("other_bucket");
    const key = parseFileObjectKey(str(obj(detail["object"])?.["key"]) ?? "", storagePrefix);
    if (!key || key.area !== "tmp") return ignored("other_key");
    return { event: { kind: "created", file_id: key.file_id }, log: { msg: "file event", kind: "created", file_id: key.file_id } };
  }

  if (source === "aws.guardduty" && type === "GuardDuty Malware Protection Object Scan Result") {
    const object = obj(detail["s3ObjectDetails"]) ?? {};
    if (str(object["bucketName"]) !== bucket) return ignored("other_bucket");
    const key = parseFileObjectKey(str(object["objectKey"]) ?? "", storagePrefix);
    if (!key || key.area !== "tmp") return ignored("other_key");
    const result = obj(detail["scanResultDetails"]) ?? {};
    // Anything but the two conclusive statuses refuses the file: fail closed.
    const outcome = OUTCOMES[str(result["scanResultStatus"]) ?? ""] ?? "error";
    const log: WorkerLogLine = { msg: "file event", kind: "scanned", file_id: key.file_id, outcome };
    if (outcome === "error") {
      const reasons = result["statusReasons"];
      const reason = Array.isArray(reasons) ? str(reasons[0]) : undefined;
      if (reason && CODE.test(reason)) log["reason"] = reason;
    }
    // The ETag of the object scanned binds the verdict to exact bytes (review B1); missing or malformed, a
    // clean verdict makes nothing ready. Not logged: it is a hash of the content.
    const etag = unquoteEtag(str(object["eTag"]));
    const scanResult: FileScanResult = etag === undefined ? { file_id: key.file_id, outcome } : { file_id: key.file_id, outcome, etag };
    return { event: { kind: "scanned", result: scanResult }, log };
  }

  return ignored("other_event");
}

/** What the loop needs from SQS (the real one below; a fake in tests). */
export interface QueueClient {
  /** Long-poll for up to 10 messages. */
  receive(): Promise<{ body: string; handle: string }[]>;
  delete(handle: string): Promise<void>;
}

/** The SDK-backed QueueClient for the stage's queue (FILE_EVENTS_QUEUE_URL). */
export function sqsQueueClient(client: SQSClient, queueUrl: string): QueueClient {
  return {
    async receive() {
      const out = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 60 }));
      return (out.Messages ?? []).flatMap((m) => (m.ReceiptHandle ? [{ body: m.Body ?? "", handle: m.ReceiptHandle }] : []));
    },
    async delete(handle) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: handle }));
    },
  };
}

/**
 * The stage's file events from SQS. A message is deleted once its event is
 * handled (enqueued as a pg-boss job) or ignored; a failure leaves it on the
 * queue, visible again after the visibility timeout (at-least-once, which
 * the jobs tolerate).
 */
export class SqsFileEvents implements FileEventSource {
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private readonly queue: QueueClient;
  private readonly options: FileEventsOptions;
  private readonly log: Log;
  private readonly timing: { errorBackoffMs: number };

  constructor(queue: QueueClient, options: FileEventsOptions, log: Log, timing: { errorBackoffMs: number } = { errorBackoffMs: 5_000 }) {
    this.queue = queue;
    this.options = options;
    this.log = log;
    this.timing = timing;
  }

  start(onEvent: (event: FileEvent) => Promise<void>): void {
    this.running = true;
    this.loop = this.run(onEvent);
  }

  private async run(onEvent: (event: FileEvent) => Promise<void>): Promise<void> {
    while (this.running) {
      let messages: { body: string; handle: string }[];
      try {
        messages = await this.queue.receive();
      } catch (error) {
        this.log({ level: "error", msg: "file events receive failed", ...errorFields(error) });
        await new Promise((r) => setTimeout(r, this.timing.errorBackoffMs));
        continue;
      }
      for (const m of messages) {
        const mapped = fileEventOf(m.body, this.options);
        try {
          if (mapped.event) await onEvent(mapped.event);
          await this.queue.delete(m.handle);
          this.log({ level: "info", ...mapped.log });
        } catch (error) {
          this.log({ level: "error", msg: "file event not handled", ...errorFields(error) });
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
