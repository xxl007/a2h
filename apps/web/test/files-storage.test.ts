// apps/web/infra/files.ts: the S3 side of attachments (m2-attachments D2,
// D6). The policy of the presigned POST and the parameters of the presigned
// GET are read back without any network. With A2H_TEST_S3_ENDPOINT (a local
// S3: LocalStack with signature validation on) the same links are used
// against storage itself: within the policy, over its size, another type,
// and a download link past its five minutes ("Old link": the storage
// refuses it). In CI no S3 runs, so those tests skip; QA's adversarial cases
// 6.2 run them against the preview's bucket.
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, test } from "vitest";
import { createFileStore, fileStoreFromEnv } from "../infra/files";

const KEY = "tmp/pr-12/files/A2H-7f3c/fAAAAAAAAAAAAAAAAAAAAAA";
const NOW = new Date("2026-11-08T10:00:00.000Z");

function policyOf(fields: Record<string, string>): { expiration: string; conditions: unknown[] } {
  return JSON.parse(Buffer.from(fields["Policy"]!, "base64").toString("utf8")) as { expiration: string; conditions: unknown[] };
}

const offline = createFileStore({
  bucket: "a2h-uploads-test",
  client: new S3Client({ region: "eu-west-3", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } }),
  now: () => NOW,
});

describe("presigned POST (D2)", () => {
  test("fixes the key, the size to exactly the declared size (review B1), the declared Content-Type, and lasts 5 minutes", async () => {
    const post = await offline.presignUpload({ key: KEY, contentType: "application/pdf", sizeBytes: 2_400_000, expiresSeconds: 300 });
    expect(post.fields["key"]).toBe(KEY);
    expect(post.fields["Content-Type"]).toBe("application/pdf");
    const policy = policyOf(post.fields);
    const signed = post.fields["X-Amz-Date"]!.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
    const lasts = new Date(policy.expiration).getTime() - new Date(signed).getTime();
    expect(lasts).toBeGreaterThanOrEqual(300_000);
    expect(lasts).toBeLessThan(301_000);
    expect(policy.conditions).toContainEqual({ key: KEY });
    expect(policy.conditions).toContainEqual({ bucket: "a2h-uploads-test" });
    expect(policy.conditions).toContainEqual(["content-length-range", 2_400_000, 2_400_000]);
    expect(policy.conditions).toContainEqual({ "Content-Type": "application/pdf" });
  });

  test("names nothing but ids: no file name anywhere in the URL or the fields", async () => {
    const post = await offline.presignUpload({ key: KEY, contentType: "image/png", sizeBytes: 10, expiresSeconds: 300 });
    expect(JSON.stringify(post)).not.toMatch(/filename|\$\{filename\}/);
  });
});

describe("presigned GET (D6)", () => {
  test("5 minutes, the recorded type, attachment for documents", async () => {
    const url = new URL(await offline.presignDownload({ key: KEY, contentType: "application/pdf", disposition: "attachment", expiresSeconds: 300 }));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(url.searchParams.get("response-content-disposition")).toBe("attachment");
    expect(url.pathname).toContain("fAAAAAAAAAAAAAAAAAAAAAA");
  });

  test("inline for images", async () => {
    const url = new URL(await offline.presignDownload({ key: KEY, contentType: "image/png", disposition: "inline", expiresSeconds: 300 }));
    expect(url.searchParams.get("response-content-disposition")).toBe("inline");
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
  });
});

describe("fileStoreFromEnv", () => {
  test("S3_ENDPOINT (a local S3) is refused on prod", () => {
    expect(() => fileStoreFromEnv({ STAGE: "prod", S3_ENDPOINT: "http://127.0.0.1:4566" }, "bucket")).toThrow(/S3_ENDPOINT is refused on prod/);
  });

  test("an endpoint that is not http(s) is refused, without echoing it", () => {
    expect(() => fileStoreFromEnv({ STAGE: "dev", S3_ENDPOINT: "file:///etc/passwd" }, "bucket")).toThrow(/^web storage configuration: S3_ENDPOINT is not an http\(s\) URL$/);
  });
});

const endpoint = process.env["A2H_TEST_S3_ENDPOINT"];

describe.skipIf(!endpoint)("against a local S3 (A2H_TEST_S3_ENDPOINT)", () => {
  const bucket = `a2h-web-files-${Date.now()}`;
  const env = { STAGE: "dev", S3_ENDPOINT: endpoint, AWS_REGION: "eu-west-3" };
  let store: ReturnType<typeof createFileStore>;

  beforeAll(async () => {
    store = fileStoreFromEnv(env, bucket);
    const client = new S3Client({ endpoint: endpoint!, forcePathStyle: true, region: "eu-west-3" });
    await client.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: "eu-west-3" } }));
  });

  async function post(p: { url: string; fields: Record<string, string> }, body: Blob, type?: string): Promise<number> {
    const form = new FormData();
    for (const [k, v] of Object.entries(p.fields)) form.set(k, k === "Content-Type" && type !== undefined ? type : v);
    form.set("file", body);
    return (await fetch(p.url, { method: "POST", body: form })).status;
  }

  test("an upload within the policy is stored, and the principal's link returns it", async () => {
    const key = `tmp/dev/files/A2H-0001/f${"B".repeat(22)}`;
    const p = await store.presignUpload({ key, contentType: "text/plain", sizeBytes: 5, expiresSeconds: 300 });
    expect(await post(p, new Blob(["hello"]))).toBeLessThan(300);
    const res = await fetch(await store.presignDownload({ key, contentType: "text/plain", disposition: "attachment", expiresSeconds: 300 }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  test("Too large: a body over the declared size is refused by the storage", async () => {
    const key = `tmp/dev/files/A2H-0001/f${"C".repeat(22)}`;
    const p = await store.presignUpload({ key, contentType: "text/plain", sizeBytes: 8, expiresSeconds: 300 });
    expect(await post(p, new Blob(["0123456789"]))).toBe(400);
  });

  test("a body under the declared size is refused by the storage too (B1: only the declared size can be stored)", async () => {
    const key = `tmp/dev/files/A2H-0001/f${"G".repeat(22)}`;
    const p = await store.presignUpload({ key, contentType: "text/plain", sizeBytes: 8, expiresSeconds: 300 });
    expect(await post(p, new Blob(["0123"]))).toBe(400);
  });

  test("another Content-Type than the declared one is refused by the storage", async () => {
    const key = `tmp/dev/files/A2H-0001/f${"D".repeat(22)}`;
    const p = await store.presignUpload({ key, contentType: "image/png", sizeBytes: 6, expiresSeconds: 300 });
    expect(await post(p, new Blob(["<html>"]), "text/html")).toBe(403);
  });

  test("Old link: a download link past its 5 minutes is refused by the storage", async () => {
    const key = `tmp/dev/files/A2H-0001/f${"E".repeat(22)}`;
    const p = await store.presignUpload({ key, contentType: "text/plain", sizeBytes: 4, expiresSeconds: 300 });
    expect(await post(p, new Blob(["kept"]))).toBeLessThan(300);
    const old = fileStoreFromEnv(env, bucket, { now: () => new Date(Date.now() - 6 * 60_000) });
    const res = await fetch(await old.presignDownload({ key, contentType: "text/plain", disposition: "attachment", expiresSeconds: 300 }));
    expect(res.status).toBe(403);
  });

  test("deleteObject removes it: the link then finds nothing", async () => {
    const key = `tmp/dev/files/A2H-0001/f${"F".repeat(22)}`;
    const p = await store.presignUpload({ key, contentType: "text/plain", sizeBytes: 4, expiresSeconds: 300 });
    expect(await post(p, new Blob(["gone"]))).toBeLessThan(300);
    await store.deleteObject(key);
    const res = await fetch(await store.presignDownload({ key, contentType: "text/plain", disposition: "attachment", expiresSeconds: 300 }));
    expect(res.status).toBe(404);
  });
});
