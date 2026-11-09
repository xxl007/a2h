// Deployment adapter for attachments (m2-attachments D2, D5, D6): presigned
// POST for the browser's upload straight to the uploads bucket, presigned GET
// for the principal's short-lived link, and deletion. One of the places in
// apps/web that import an AWS SDK (apps/web/infra); app/ and src/ code
// against `FileStore` only. Keys carry ids only (`tmp/<prefix>files/<request
// id>/<file id>`, `uploads/<prefix>files/…`): never a file name, so no file
// name reaches a URL, a policy or an S3 log.
//
// S3_ENDPOINT (never set on a deployed stage, refused on prod) points the
// client at a local S3 (LocalStack) for a local server and its tests.
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type Env = Record<string, string | undefined>;

export interface PresignedUpload {
  url: string;
  /** Form fields to post before the file (key, policy, signature, Content-Type). */
  fields: Record<string, string>;
}

export interface FileStore {
  /** A POST policy bound to `key`, 1..`maxBytes` bytes and exactly `contentType`. */
  presignUpload(i: { key: string; contentType: string; maxBytes: number; expiresSeconds: number }): Promise<PresignedUpload>;
  /** A GET link to `key` served with `contentType` and the given disposition (no file name). */
  presignDownload(i: { key: string; contentType: string; disposition: "inline" | "attachment"; expiresSeconds: number }): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export interface FileStoreOptions {
  bucket: string;
  client: S3Client;
  /** The download links' signing clock (tests: a link signed in the past). */
  now?: () => Date;
}

function fail(message: string): never {
  throw new Error(`web storage configuration: ${message}`);
}

export function createFileStore(o: FileStoreOptions): FileStore {
  const now = o.now ?? (() => new Date());
  return {
    async presignUpload(i) {
      // The policy's expiration is `Expires` seconds from the client's clock.
      const post = await createPresignedPost(o.client, {
        Bucket: o.bucket,
        Key: i.key,
        Fields: { "Content-Type": i.contentType },
        Conditions: [["content-length-range", 1, i.maxBytes], { "Content-Type": i.contentType }],
        Expires: i.expiresSeconds,
      });
      return { url: post.url, fields: post.fields };
    },
    async presignDownload(i) {
      return getSignedUrl(
        o.client,
        new GetObjectCommand({ Bucket: o.bucket, Key: i.key, ResponseContentType: i.contentType, ResponseContentDisposition: i.disposition }),
        { expiresIn: i.expiresSeconds, signingDate: now() },
      );
    },
    async deleteObject(key) {
      await o.client.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: key }));
    },
  };
}

/** The stage's store: the uploads bucket, or a local S3 at S3_ENDPOINT (non-prod only). */
export function fileStoreFromEnv(env: Env, bucket: string, options: { now?: () => Date } = {}): FileStore {
  const endpoint = env["S3_ENDPOINT"];
  if (endpoint) {
    if (env["STAGE"] === "prod") fail("S3_ENDPOINT is refused on prod");
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      fail("S3_ENDPOINT is not an http(s) URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") fail("S3_ENDPOINT is not an http(s) URL");
    const client = new S3Client({
      endpoint,
      forcePathStyle: true,
      region: env["AWS_REGION"] ?? "eu-west-3",
      // A local S3 takes any key pair; never a deployed stage's credentials.
      credentials: { accessKeyId: env["S3_ACCESS_KEY_ID"] ?? "test", secretAccessKey: env["S3_SECRET_ACCESS_KEY"] ?? "test" },
    });
    return createFileStore({ bucket, client, ...options });
  }
  return createFileStore({ bucket, client: new S3Client({}), ...options });
}
