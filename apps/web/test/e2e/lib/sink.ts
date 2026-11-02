// Minimal reader of a stage's mail sink (design D6) for these flows: the
// newest message to an address written after a given time. Local server:
// A2H_MAIL_SINK_DIR (its LOCAL_MAIL_DIR). Deployed stage: A2H_MAIL_SINK_BUCKET
// with AWS credentials that may read `tmp/<stage>/mail/` (the deploy role).
// QA's shared helper (tests/lib/mail-sink.ts, task 6.2) replaces this file.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { STAGE } from "./env";

export interface SinkMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  sent_at: string;
  id: string;
}

const PREFIX = `tmp/${STAGE}/mail/`;

async function listLocal(dir: string): Promise<SinkMessage[]> {
  const root = join(dir, PREFIX);
  const names = await readdir(root).catch(() => [] as string[]);
  return Promise.all(names.filter((n) => n.endsWith(".json")).map(async (n) => JSON.parse(await readFile(join(root, n), "utf8")) as SinkMessage));
}

async function listS3(bucket: string, since: Date): Promise<SinkMessage[]> {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({});
  const out: SinkMessage[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
    for (const obj of page.Contents ?? []) {
      if (!obj.Key || (obj.LastModified && obj.LastModified < new Date(since.getTime() - 5_000))) continue;
      const body = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }))).Body?.transformToString();
      if (body) out.push(JSON.parse(body) as SinkMessage);
    }
    token = page.NextContinuationToken;
  } while (token);
  return out;
}

export async function messagesTo(address: string, since: Date): Promise<SinkMessage[]> {
  const dir = process.env["A2H_MAIL_SINK_DIR"];
  const bucket = process.env["A2H_MAIL_SINK_BUCKET"];
  if (!dir && !bucket) throw new Error("set A2H_MAIL_SINK_DIR (local server) or A2H_MAIL_SINK_BUCKET (deployed stage)");
  const all = dir ? await listLocal(dir) : await listS3(bucket!, since);
  return all
    .filter((m) => m.to.toLowerCase() === address.toLowerCase() && new Date(m.sent_at) >= since)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Waits for the newest link to `address` sent after `since`. */
export async function newestLink(address: string, since: Date, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await messagesTo(address, since);
    const last = list.at(-1);
    const link = last?.text.match(/https?:\/\/\S+magic-link\/verify\S+/)?.[0];
    if (link) return link;
    if (Date.now() > deadline) throw new Error("no magic link in the mail sink");
    await new Promise((r) => setTimeout(r, 500));
  }
}
