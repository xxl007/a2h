// m2-attachments task 3.2, ADR 0005 items 4 and 5: the deployment adapter in
// apps/worker/infra, the only code that knows the shapes of S3's and
// GuardDuty's events. It maps them to FileEvents carrying opaque ids and an
// outcome, drops the detection name, hash and reasons, and ignores anything
// outside this stage's `tmp/<prefix>files/`. Also the SQS loop (with a fake
// queue client) and the S3 store (with a fake S3 client): no AWS in tests.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileEventOf, SqsFileEvents, type QueueClient } from "../infra/file-events.ts";
import { S3FileStore } from "../infra/s3-store.ts";
import type { FileEvent } from "../src/files/events.ts";
import type { WorkerLogLine } from "../src/log.ts";

const BUCKET = "a2h-dev-uploadsbucket-vnkxkhnk";
const PREFIX = "pr-12/";
const FILE = "fAAAAAAAAAAAAAAAAAAAAAB";
const KEY = `tmp/pr-12/files/A2H-7f3c/${FILE}`;
const opts = { bucket: BUCKET, storagePrefix: PREFIX };

function created(key = KEY, bucket = BUCKET) {
  return JSON.stringify({
    version: "0",
    "detail-type": "Object Created",
    source: "aws.s3",
    detail: { version: "0", bucket: { name: bucket }, object: { key, size: 1234, etag: "x" }, reason: "PostObject" },
  });
}

function scanned(status: string, extra: Record<string, unknown> = {}, key = KEY, bucket = BUCKET) {
  return JSON.stringify({
    version: "0",
    "detail-type": "GuardDuty Malware Protection Object Scan Result",
    source: "aws.guardduty",
    detail: {
      schemaVersion: "1.0",
      scanStatus: status === "NO_THREATS_FOUND" || status === "THREATS_FOUND" ? "COMPLETED" : status === "FAILED" ? "FAILED" : "SKIPPED",
      resourceType: "S3_OBJECT",
      s3ObjectDetails: { bucketName: bucket, objectKey: key, eTag: "e", versionId: "v", s3Throttled: false },
      scanResultDetails: { scanResultStatus: status, threats: null, statusReasons: null, ...extra },
    },
  });
}

describe("fileEventOf: provider events → FileEvent", () => {
  test("S3 Object Created under this stage's tmp/<prefix>files/ → created", () => {
    assert.deepEqual(fileEventOf(created(), opts).event, { kind: "created", file_id: FILE });
  });

  test("GuardDuty statuses map to clean, threat, error (ADR 0005 item 5)", () => {
    const cases: [string, "clean" | "threat" | "error"][] = [
      ["NO_THREATS_FOUND", "clean"],
      ["THREATS_FOUND", "threat"],
      ["UNSUPPORTED", "error"],
      ["ACCESS_DENIED", "error"],
      ["FAILED", "error"],
      ["SOMETHING_NEW", "error"],
    ];
    for (const [status, outcome] of cases) {
      assert.deepEqual(fileEventOf(scanned(status), opts).event, { kind: "scanned", result: { file_id: FILE, outcome } }, status);
    }
  });

  test("the detection name and hash are dropped: neither the event nor the log line carries them", () => {
    const body = scanned("THREATS_FOUND", { threats: [{ name: "EICAR-Test-File (not a virus)", source: "AMAZON", itemDetails: [{ hash: "e3b0c44298fc1c149afbf4c8996fb924", itemPath: KEY }] }] });
    const mapped = fileEventOf(body, opts);
    const text = JSON.stringify(mapped);
    assert.ok(!text.includes("EICAR") && !text.includes("e3b0c442"), text);
    assert.deepEqual(mapped.log, { msg: "file event", kind: "scanned", file_id: FILE, outcome: "threat" });
  });

  test("an error keeps only the status reason code (e.g. a password-protected PDF)", () => {
    const mapped = fileEventOf(scanned("UNSUPPORTED", { statusReasons: ["PASSWORD_PROTECTED"] }), opts);
    assert.deepEqual(mapped.log, { msg: "file event", kind: "scanned", file_id: FILE, outcome: "error", reason: "PASSWORD_PROTECTED" });
    const odd = fileEventOf(scanned("UNSUPPORTED", { statusReasons: ["<not a code> report.pdf"] }), opts);
    assert.equal(odd.log["reason"], undefined, "anything but a plain code is not logged");
  });

  test("anything else is ignored: other stages, other areas, other buckets, the validation object, other events, garbage", () => {
    const ignored = [
      created(`tmp/pr-120/files/A2H-7f3c/${FILE}`),
      created(`tmp/dev/files/A2H-7f3c/${FILE}`),
      created(`uploads/pr-12/files/A2H-7f3c/${FILE}`),
      created("tmp/pr-12/mail/abc.json"),
      created("malware-protection-resource-validation-object"),
      created(KEY, "another-bucket"),
      scanned("NO_THREATS_FOUND", {}, `uploads/pr-12/files/A2H-7f3c/${FILE}`),
      scanned("NO_THREATS_FOUND", {}, KEY, "another-bucket"),
      JSON.stringify({ source: "aws.guardduty", "detail-type": "GuardDuty Malware Protection Post Scan Action Failed", detail: {} }),
      "not json",
      "null",
    ];
    for (const body of ignored) {
      const mapped = fileEventOf(body, opts);
      assert.equal(mapped.event, null, body);
      assert.equal(mapped.log.msg, "file event ignored");
      // An ignored event's log line names no key (a key could belong to another stage).
      assert.ok(!JSON.stringify(mapped.log).includes("/"), JSON.stringify(mapped.log));
    }
  });
});

class FakeQueue implements QueueClient {
  batches: { body: string; handle: string }[][] = [];
  deleted: string[] = [];
  receive(): Promise<{ body: string; handle: string }[]> {
    return sleep(5).then(() => this.batches.shift() ?? []);
  }
  delete(handle: string): Promise<void> {
    this.deleted.push(handle);
    return Promise.resolve();
  }
}

describe("SqsFileEvents: the queue loop", () => {
  test("hands each mapped event to the worker and deletes the message only once it is handled; ignored messages are deleted", async () => {
    const queue = new FakeQueue();
    queue.batches.push([
      { body: created(), handle: "h1" },
      { body: "garbage", handle: "h2" },
      { body: scanned("NO_THREATS_FOUND"), handle: "h3" },
    ]);
    const logs: WorkerLogLine[] = [];
    const seen: FileEvent[] = [];
    let failOnce = true;
    const source = new SqsFileEvents(queue, opts, (l) => logs.push(l), { errorBackoffMs: 1 });
    source.start((e) => {
      if (e.kind === "scanned" && failOnce) {
        failOnce = false;
        return Promise.reject(new Error("pg-boss unavailable"));
      }
      seen.push(e);
      return Promise.resolve();
    });
    for (let i = 0; i < 100 && queue.deleted.length < 2; i++) await sleep(10);
    await source.stop();
    assert.deepEqual(seen, [{ kind: "created", file_id: FILE }]);
    assert.deepEqual(queue.deleted.sort(), ["h1", "h2"], "h3 failed: left on the queue for redelivery");
    assert.ok(logs.some((l) => l.msg === "file event not handled"));
  });
});

describe("S3FileStore", () => {
  type Sent = { name: string; input: Record<string, unknown> };
  function fakeS3(reply: (c: Sent) => unknown) {
    const sent: Sent[] = [];
    return {
      sent,
      client: {
        send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const c = { name: command.constructor.name, input: command.input };
          sent.push(c);
          try {
            return Promise.resolve(reply(c));
          } catch (e) {
            return Promise.reject(e instanceof Error ? e : new Error("unexpected"));
          }
        },
      },
    };
  }

  test("head reads a byte range and the full size from Content-Range", async () => {
    const s3 = fakeS3(() => ({ ContentRange: "bytes 0-3/12345", Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([37, 80, 68, 70])) } }));
    const store = new S3FileStore(s3.client, BUCKET);
    assert.deepEqual(await store.head(KEY, 8192), { bytes: new Uint8Array([37, 80, 68, 70]), size: 12345 });
    assert.deepEqual(s3.sent[0], { name: "GetObjectCommand", input: { Bucket: BUCKET, Key: KEY, Range: "bytes=0-8191" } });
  });

  test("head of a missing object is null", async () => {
    const s3 = fakeS3(() => {
      throw Object.assign(new Error("gone"), { name: "NoSuchKey" });
    });
    assert.equal(await new S3FileStore(s3.client, BUCKET).head(KEY, 8192), null);
  });

  test("copy keeps the tags (the scanner's clean tag) and sets the recorded type", async () => {
    const s3 = fakeS3(() => ({}));
    await new S3FileStore(s3.client, BUCKET).copy(KEY, `uploads/pr-12/files/A2H-7f3c/${FILE}`, "application/pdf");
    assert.deepEqual(s3.sent[0], {
      name: "CopyObjectCommand",
      input: {
        Bucket: BUCKET,
        Key: `uploads/pr-12/files/A2H-7f3c/${FILE}`,
        CopySource: `${BUCKET}/${KEY}`,
        TaggingDirective: "COPY",
        MetadataDirective: "REPLACE",
        ContentType: "application/pdf",
      },
    });
  });

  test("delete", async () => {
    const s3 = fakeS3(() => ({}));
    await new S3FileStore(s3.client, BUCKET).delete(KEY);
    assert.deepEqual(s3.sent[0], { name: "DeleteObjectCommand", input: { Bucket: BUCKET, Key: KEY } });
  });
});
