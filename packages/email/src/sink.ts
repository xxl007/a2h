// The stage mail sink (design D6): on every stage but prod, a message is
// written as JSON to the stage's own prefix in the uploads bucket instead of
// being sent. Nothing on a non-prod stage can send email, by construction.
// No AWS import: the object client is a one-method interface the caller
// adapts from S3Client (`(a) => s3.send(new PutObjectCommand({...}))`).
import { ulid } from "ulid";
import type { Mailer, Message } from "./mailer.ts";

export interface PutObjectArgs {
  bucket: string;
  key: string;
  body: string;
  contentType: string;
}

/** Put only: the sink never reads, lists or deletes. */
export interface ObjectPutClient {
  putObject(args: PutObjectArgs): Promise<unknown>;
}

export interface S3SinkMailerOptions {
  client: ObjectPutClient;
  bucket: string;
  /** The stage's key prefix, e.g. `dev/` or `pr-12/`; never empty. */
  prefix: string;
  /** Clock, for tests. */
  now?: () => Date;
}

/** What one sink object holds (`<prefix>mail/<id>.json`). */
export interface SinkRecord extends Message {
  sent_at: string;
  id: string;
}

export class S3SinkMailer implements Mailer {
  readonly #client: ObjectPutClient;
  readonly #bucket: string;
  readonly #root: string;
  readonly #now: () => Date;

  constructor(options: S3SinkMailerOptions) {
    const prefix = options.prefix.replace(/\/+$/, "");
    if (!prefix) throw new TypeError("S3SinkMailer needs a non-empty stage prefix.");
    if (!options.bucket) throw new TypeError("S3SinkMailer needs a bucket.");
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#root = `${prefix}/mail/`;
    this.#now = options.now ?? (() => new Date());
  }

  async send(message: Message): Promise<{ id: string }> {
    const sentAt = this.#now();
    // ULID: 48-bit millisecond time first, so keys sort by send time and the
    // newest message is the last key under the prefix.
    const id = ulid(sentAt.getTime());
    const record: SinkRecord = {
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      sent_at: sentAt.toISOString(),
      id,
    };
    await this.#client.putObject({
      bucket: this.#bucket,
      key: `${this.#root}${id}.json`,
      body: JSON.stringify(record),
      contentType: "application/json",
    });
    return { id };
  }
}
