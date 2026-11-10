// The local stage's stand-in for what AWS does around the uploads bucket
// (m2-attachments ADR 0005 item 4): S3's "Object Created" event and
// GuardDuty's "Malware Protection Object Scan Result", both written as the
// EventBridge events the stage's rule forwards, onto the stage's SQS queue
// (LocalStack). The real worker reads that queue with its real adapter
// (apps/worker/infra/file-events.ts), checks the bytes with its real
// `file-check` job, applies the result with its real `file-scan` job and
// copies or deletes with its real S3 store. Only the producer of the two
// events is fake, and only here: QA tooling, never deployed.
//
// What the fake scanner answers, from the object's bytes (it reads the whole
// object, as GuardDuty does):
// - the EICAR test string anywhere: THREATS_FOUND, with a detection name the
//   adapter must drop;
// - SCAN_WITHHOLD_MARKER anywhere: no result ever (spec "Scan does not
//   finish": the worker's 10-minute limit refuses the file);
// - SCAN_UNSUPPORTED_MARKER anywhere: SKIPPED / UNSUPPORTED (what GuardDuty
//   reports for a password-protected PDF);
// - anything else: NO_THREATS_FOUND.
// Every result is delivered twice (EventBridge and SQS deliver at least
// once), so the worker's idempotence is exercised on every file.
//
// Each version of an object is its own object, as for S3 and GuardDuty: a
// key POSTed again with a new body (a new ETag) gets a new "Object Created"
// event and a new scan, and every event and result names the ETag of the
// bytes it is about (S3's `object.etag`, GuardDuty's `s3ObjectDetails.eTag`).
//
// The hold control (adversarial F9, re-upload between the check and the scan
// result): a test that puts `SCAN_CONTROL_PREFIX + "hold/" + <file id>` in
// the bucket before posting has every verdict on that file's key scanned as
// usual (the bytes read, the ETag noted) but held back, until it puts
// `SCAN_CONTROL_PREFIX + "release/" + <file id>` (or HOLD_LIMIT_MS passes);
// then the held verdicts are sent in the order their versions were scanned.
// A held scan logs "fake scanner: result held" with the version's ETag.
// The control keys are outside the stage's prefix: the worker never sees them.
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";

/** A file whose bytes hold this never gets a scan result (local stage only). */
export const SCAN_WITHHOLD_MARKER = "A2H-QA-SCAN-WITHHOLD";
/** A file whose bytes hold this is reported UNSUPPORTED by the scanner (local stage only). */
export const SCAN_UNSUPPORTED_MARKER = "A2H-QA-SCAN-UNSUPPORTED";
/** Where a test puts `hold/<file id>` and `release/<file id>` (local stage only). */
export const SCAN_CONTROL_PREFIX = "qa-control/scan/";
/** A held verdict is sent anyway after this long (a test that never releases must not hang the stage). */
export const HOLD_LIMIT_MS = 180_000;

/** Built from parts so that no file in the repository carries the EICAR string whole. */
export function eicar(): string {
  return ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-", "TEST-FILE!$H+H*"].join("");
}

export interface FakeScannerOptions {
  s3: S3Client;
  sqs: SQSClient;
  bucket: string;
  queueUrl: string;
  /** `tmp/<STORAGE_PREFIX>files/`. */
  prefix: string;
  /** Delay between the object's event and its scan result (the page shows "Checking" meanwhile). */
  scanDelayMs?: number;
  log?: (line: Record<string, unknown>) => void;
}

export interface FakeScanner {
  stop(): Promise<void>;
  /** Keys seen so far and what the scanner answered for each (tests). */
  readonly verdicts: Map<string, string>;
}

/** S3's ETag without its quotes, as EventBridge events carry it. */
const bare = (etag: string | undefined): string => (etag ?? "").replace(/^"|"$/g, "");

export function objectCreated(bucket: string, key: string, size: number, etag = ""): string {
  return JSON.stringify({
    version: "0",
    source: "aws.s3",
    "detail-type": "Object Created",
    region: "eu-west-3",
    detail: { version: "0", bucket: { name: bucket }, object: { key, size, etag: bare(etag) }, reason: "PostObject" },
  });
}

export function scanResult(bucket: string, key: string, status: "NO_THREATS_FOUND" | "THREATS_FOUND" | "UNSUPPORTED", etag = "0"): string {
  return JSON.stringify({
    version: "0",
    source: "aws.guardduty",
    "detail-type": "GuardDuty Malware Protection Object Scan Result",
    region: "eu-west-3",
    detail: {
      schemaVersion: "1.0",
      scanStatus: status === "UNSUPPORTED" ? "SKIPPED" : "COMPLETED",
      resourceType: "S3_OBJECT",
      s3ObjectDetails: { bucketName: bucket, objectKey: key, eTag: bare(etag), versionId: null },
      scanResultDetails: {
        scanResultStatus: status,
        threats: status === "THREATS_FOUND" ? [{ name: "EICAR-Test-File (not a virus)" }] : null,
        ...(status === "UNSUPPORTED" ? { statusReasons: ["PASSWORD_PROTECTED"] } : {}),
      },
    },
  });
}

export function startFakeScanner(o: FakeScannerOptions): FakeScanner {
  const log = o.log ?? (() => undefined);
  const delay = o.scanDelayMs ?? 2_000;
  const seen = new Set<string>();
  const verdicts = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  let stopped = false;
  const send = (body: string) => o.sqs.send(new SendMessageCommand({ QueueUrl: o.queueUrl, MessageBody: body }));
  const exists = async (key: string): Promise<boolean> => {
    try {
      await o.s3.send(new HeadObjectCommand({ Bucket: o.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  };
  /** Per key: the held verdicts, sent one after the other once released (scan order). */
  const held = new Map<string, Promise<void>>();

  const scan = async (key: string): Promise<void> => {
    await new Promise((r) => setTimeout(r, delay));
    if (stopped) return;
    const fileId = key.slice(-23);
    let text: string;
    let etag: string;
    try {
      const out = await o.s3.send(new GetObjectCommand({ Bucket: o.bucket, Key: key }));
      text = Buffer.from(await out.Body!.transformToByteArray()).toString("latin1");
      etag = bare(out.ETag);
    } catch {
      verdicts.set(key, "gone");
      return; // removed or refused before the scan: GuardDuty would report nothing useful either
    }
    if (text.includes(SCAN_WITHHOLD_MARKER)) {
      verdicts.set(key, "withheld");
      log({ msg: "fake scanner: result withheld", key_tail: fileId });
      return;
    }
    const status = text.includes(eicar()) ? "THREATS_FOUND" : text.includes(SCAN_UNSUPPORTED_MARKER) ? "UNSUPPORTED" : "NO_THREATS_FOUND";
    verdicts.set(key, status);
    const body = scanResult(o.bucket, key, status, etag);
    const deliver = async () => {
      await send(body);
      await send(body); // at least once
      log({ msg: "fake scanner: result sent twice", key_tail: fileId, status, etag });
    };
    if (!held.has(key) && !(await exists(`${SCAN_CONTROL_PREFIX}hold/${fileId}`))) return deliver();
    log({ msg: "fake scanner: result held", key_tail: fileId, status, etag });
    const release = async () => {
      const end = Date.now() + HOLD_LIMIT_MS;
      while (!stopped && Date.now() < end && !(await exists(`${SCAN_CONTROL_PREFIX}release/${fileId}`))) await new Promise((r) => setTimeout(r, 300));
    };
    const next = (held.get(key) ?? release()).then(deliver);
    held.set(key, next.catch(() => undefined));
    return next;
  };

  const tick = async (): Promise<void> => {
    let token: string | undefined;
    do {
      const page = await o.s3.send(new ListObjectsV2Command({ Bucket: o.bucket, Prefix: o.prefix, ContinuationToken: token }));
      for (const item of page.Contents ?? []) {
        const key = item.Key!;
        // A version: the same key POSTed again with other bytes is a new object to S3 and to the scanner.
        const version = `${key} ${bare(item.ETag)}`;
        if (seen.has(version)) continue;
        seen.add(version);
        await send(objectCreated(o.bucket, key, item.Size ?? 0, item.ETag));
        const p = scan(key).catch((e: unknown) => log({ msg: "fake scanner: scan failed", error: String(e) }));
        pending.add(p);
        void p.finally(() => pending.delete(p));
      }
      token = page.NextContinuationToken;
    } while (token);
  };

  const loop = (async () => {
    while (!stopped) {
      await tick().catch((e: unknown) => log({ msg: "fake scanner: list failed", error: String(e) }));
      await new Promise((r) => setTimeout(r, 700));
    }
  })();

  return {
    verdicts,
    async stop() {
      stopped = true;
      await loop;
      await Promise.allSettled([...pending]);
    },
  };
}
