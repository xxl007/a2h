// Reader of a stage's mail sink (m1-hosted-connector task 6.2; design D6).
// On every stage but prod, a magic link is written as JSON to
// `tmp/<stage>/mail/<ulid>.json` in the uploads bucket instead of being sent
// (packages/email S3SinkMailer, apps/web/infra/mail.ts). Reading it needs the
// stage's deploy role (QA in the verify jobs, the owner from the CLI); a
// local server writes the same layout under LOCAL_MAIL_DIR.
//
// The key's ULID starts with the send time, so the listing starts after the
// ULID lower bound of `since` and only newer objects are fetched. The record
// shape is the email package's SinkRecord: no duplicated shape here.
//
// Environment (sinkClientFromEnv): A2H_MAIL_SINK_DIR (a local server's
// LOCAL_MAIL_DIR) or A2H_MAIL_SINK_BUCKET (a deployed stage; AWS credentials
// from the usual chain). Nothing here logs an address or a link.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SinkRecord } from "@a2h/email/sink";

export type { SinkRecord } from "@a2h/email/sink";

/** Put-less, read-only view of the object store the sink writes to. */
export interface SinkObjectClient {
  /** Every key under `prefix` that sorts after `startAfter` (all pages), in key order. */
  list(prefix: string, startAfter: string | undefined): Promise<string[]>;
  get(key: string): Promise<string>;
}

const STAGE = /^(dev|pr-[1-9][0-9]*)$/;

/** `tmp/<stage>/mail/`: the sink of a non-production stage. */
export function sinkPrefix(stage: string): string {
  if (stage === "prod") throw new Error("prod has no mail sink: magic links leave production through email only");
  if (!STAGE.test(stage)) throw new Error(`${JSON.stringify(stage)} is not a stage (dev or pr-<n>)`);
  return `tmp/${stage}/mail/`;
}

// Crockford base32, as the ulid package encodes the 48-bit time prefix.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The smallest ULID whose time part is `at`: every ULID minted at or after `at` sorts at or after it. */
export function ulidLowerBound(at: Date): string {
  let t = at.getTime();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return `${time}0000000000000000`;
}

/** Clock skew allowed between the caller and the server that wrote the object. */
const SKEW_MS = 2_000;

/** Messages to `address` (case-insensitive) sent at or after `since` (minus skew), oldest first. */
export async function messagesTo(client: SinkObjectClient, stage: string, address: string, since: Date): Promise<SinkRecord[]> {
  const prefix = sinkPrefix(stage);
  const floor = new Date(since.getTime() - SKEW_MS);
  const keys = await client.list(prefix, `${prefix}${ulidLowerBound(floor)}`);
  const wanted = address.trim().toLowerCase();
  const out: SinkRecord[] = [];
  for (const key of keys) {
    if (!key.endsWith(".json")) continue;
    const record = JSON.parse(await client.get(key)) as SinkRecord;
    if (record.to.trim().toLowerCase() !== wanted) continue;
    if (new Date(record.sent_at) < floor) continue;
    out.push(record);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function newestMessageTo(client: SinkObjectClient, stage: string, address: string, since: Date): Promise<SinkRecord | undefined> {
  return (await messagesTo(client, stage, address, since)).at(-1);
}

const MAGIC_LINK = /https?:\/\/[^\s<>"']+\/magic-link\/verify[^\s<>"']*/;

/** The magic link in a sink message's text, without trailing punctuation; undefined when there is none. */
export function magicLinkOf(message: Pick<SinkRecord, "text">): string | undefined {
  const match = MAGIC_LINK.exec(message.text)?.[0];
  return match?.replace(/[.,;:)]+$/, "");
}

export interface WaitOptions {
  timeoutMs?: number;
  everyMs?: number;
}

/** Polls the sink for the newest message to `address` since `since` carrying a magic link. The error never names the address. */
export async function waitForMagicLink(client: SinkObjectClient, stage: string, address: string, since: Date, options: WaitOptions = {}): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const newest = await newestMessageTo(client, stage, address, since);
    const link = newest ? magicLinkOf(newest) : undefined;
    if (link) return link;
    if (Date.now() > deadline) {
      throw new Error(`no magic link in the mail sink of ${stage} within ${options.timeoutMs ?? 30_000} ms (is the address on the allow-list? runbook §15)`);
    }
    await sleep(options.everyMs ?? 1_000);
  }
}

/** A local server's LOCAL_MAIL_DIR, laid out like the bucket (apps/web/infra/mail.ts localObjectClient). */
export function localSinkClient(dir: string): SinkObjectClient {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    const path = resolve(join(root, key));
    if (!path.startsWith(root + sep)) throw new Error("object key escapes the local mail directory");
    return path;
  };
  return {
    async list(prefix, startAfter) {
      const names = await readdir(pathOf(prefix)).catch(() => [] as string[]);
      return names
        .map((n) => `${prefix}${n}`)
        .filter((k) => startAfter === undefined || k > startAfter)
        .sort();
    },
    get(key) {
      return readFile(pathOf(key), "utf8");
    },
  };
}

/** The uploads bucket of a deployed stage, through @aws-sdk/client-s3 (loaded only here, only when needed). */
export function s3SinkClient(bucket: string): SinkObjectClient {
  const sdk = import("@aws-sdk/client-s3");
  const client = sdk.then(({ S3Client }) => new S3Client({}));
  return {
    async list(prefix, startAfter) {
      const { ListObjectsV2Command } = await sdk;
      const s3 = await client;
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, StartAfter: startAfter, ContinuationToken: token }));
        for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = page.NextContinuationToken;
      } while (token);
      return keys.sort();
    },
    async get(key) {
      const { GetObjectCommand } = await sdk;
      const s3 = await client;
      const body = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body?.transformToString();
      if (body === undefined) throw new Error("empty sink object");
      return body;
    },
  };
}

/** The client the environment names: a local directory or a bucket. */
export function sinkClientFromEnv(env: Record<string, string | undefined> = process.env): { client: SinkObjectClient; source: string } {
  const dir = env["A2H_MAIL_SINK_DIR"]?.trim();
  if (dir) return { client: localSinkClient(dir), source: `dir ${dir}` };
  const bucket = env["A2H_MAIL_SINK_BUCKET"]?.trim();
  if (bucket) return { client: s3SinkClient(bucket), source: `s3://${bucket}` };
  throw new Error(
    "set A2H_MAIL_SINK_DIR (a local server's LOCAL_MAIL_DIR) or A2H_MAIL_SINK_BUCKET (the uploads bucket of a deployed stage, " +
      "read with the stage's deploy role; SSM /a2h/shared/uploads-bucket)",
  );
}
