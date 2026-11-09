// LocalStack (S3 and SQS) in Docker for the local stage's files
// (m2-attachments): the uploads bucket with the CORS a deployed stage's
// bucket gets from infra/storage.ts (POST only, from the web origin), and
// the stage's file-events queue. Signature validation stays on, so presigned
// POST policies and GET links are checked as S3 checks them. The container
// is removed with its volumes on stop (`docker rm -fv`); nothing is pruned.
import { execFileSync } from "node:child_process";
import { CreateBucketCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateQueueCommand, SQSClient } from "@aws-sdk/client-sqs";

export const LOCALSTACK_IMAGE = "localstack/localstack:4.4.0";
const REGION = "eu-west-3";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };

export interface LocalStorage {
  endpoint: string;
  bucket: string;
  queueUrl: string;
  s3: S3Client;
  sqs: SQSClient;
  stop(): Promise<void>;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/** `cors: false`: no CORS on the bucket, as dev's bucket is for previews until dev deploys m2-attachments. */
export async function startLocalStorage({ webOrigin, bucket = "a2h-uploads-local", cors = true }: { webOrigin: string; bucket?: string; cors?: boolean }): Promise<LocalStorage> {
  const name = `a2h-qa-localstack-${process.pid}`;
  docker(["run", "-d", "--name", name, "-p", "127.0.0.1::4566", "-e", "SERVICES=s3,sqs", "-e", "S3_SKIP_SIGNATURE_VALIDATION=0", "-e", "EAGER_SERVICE_LOADING=1", LOCALSTACK_IMAGE]);
  const stop = (): Promise<void> => {
    try {
      docker(["rm", "-fv", name]);
    } catch {
      // already gone
    }
    return Promise.resolve();
  };
  try {
    const port = docker(["port", name, "4566/tcp"]).split("\n")[0]!.split(":").at(-1)!;
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const res = await fetch(`${endpoint}/_localstack/health`);
        const health = (await res.json()) as { services?: Record<string, string> };
        if (["s3", "sqs"].every((s) => /running|available/.test(health.services?.[s] ?? ""))) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error("LocalStack did not start within 90 s");
      await new Promise((r) => setTimeout(r, 1000));
    }
    const s3 = new S3Client({ endpoint, forcePathStyle: true, region: REGION, credentials: CREDENTIALS });
    const sqs = new SQSClient({ endpoint, region: REGION, credentials: CREDENTIALS });
    await s3.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: REGION } }));
    // As infra/storage.ts gives each stage's web origin: POST only.
    if (cors) await s3.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: { CORSRules: [{ AllowedOrigins: [webOrigin], AllowedMethods: ["POST"], AllowedHeaders: ["*"], MaxAgeSeconds: 600 }] },
      }),
    );
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "a2h-pr-12-file-events", Attributes: { VisibilityTimeout: "60" } }));
    return { endpoint, bucket, queueUrl: queue.QueueUrl!, s3, sqs, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
