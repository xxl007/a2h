// Deployment adapter: the file jobs' object store on S3 (m2-attachments
// design D3, D5). The worker's task role may read, write and delete under
// `tmp/<prefix>files/` and `uploads/<prefix>files/` only (infra/access.ts),
// and the bucket policy lets it read an object in tmp/ before the scan ends
// (ADR 0005 item 7). Bodies are never logged.
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { FileObjectEtagSchema } from "@a2h/protocol";
import type { FileStore, ObjectHead } from "../src/files/store.ts";

/** What the store needs of an S3 client: `send`. */
export interface S3Sender {
  send(command: unknown): Promise<unknown>;
}

const CONTENT_RANGE = /^bytes \d+-\d+\/(\d+)$/;

/** S3 quotes ETags; the protocol's form has no quotes. */
export function unquoteEtag(etag: string | undefined): string | undefined {
  const bare = etag?.replace(/^"(.*)"$/, "$1");
  return bare !== undefined && FileObjectEtagSchema.safeParse(bare).success ? bare : undefined;
}

function isGone(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return error.name === "PreconditionFailed" || error.name === "NoSuchKey" || status === 412;
}

export class S3FileStore implements FileStore {
  private readonly client: S3Sender;
  private readonly bucket: string;

  constructor(client: S3Sender, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async head(key: string, length: number): Promise<ObjectHead | null> {
    let out: { ContentRange?: string; ContentLength?: number; ETag?: string; Body?: { transformToByteArray(): Promise<Uint8Array> } };
    try {
      out = (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${length - 1}` }))) as typeof out;
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") return null;
      throw error;
    }
    // The ETag of the object this range came from: a check is bound to it (review B1).
    const etag = unquoteEtag(out.ETag);
    if (etag === undefined) throw new Error("S3 returned no usable ETag for the object read");
    const bytes = out.Body ? await out.Body.transformToByteArray() : new Uint8Array(0);
    const total = CONTENT_RANGE.exec(out.ContentRange ?? "")?.[1];
    return { bytes, size: total !== undefined ? Number(total) : (out.ContentLength ?? bytes.length), etag };
  }

  async copy(from: string, to: string, contentType: string, ifMatch: string): Promise<"copied" | "changed"> {
    try {
      await this.send(from, to, contentType, ifMatch);
    } catch (error) {
      // 412: the object now holds other bytes than those checked and scanned; NoSuchKey: it is gone.
      if (isGone(error)) return "changed";
      throw error;
    }
    return "copied";
  }

  private async send(from: string, to: string, contentType: string, ifMatch: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: to,
        // Keys are `<area>/<prefix>files/<request id>/<file id>`: no character needs encoding.
        CopySource: `${this.bucket}/${from}`,
        // Only the bytes checked and scanned clean are copied (review B1).
        CopySourceIfMatch: `"${ifMatch}"`,
        // The scanner's GuardDutyMalwareScanStatus tag travels with the copy: the web role reads uploads/ only when it is clean.
        TaggingDirective: "COPY",
        MetadataDirective: "REPLACE",
        ContentType: contentType,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
