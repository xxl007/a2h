// What moves an uploaded file to ready or refused on the stage under test
// (m2-attachments D3). On a deployed stage it is the worker (group 3: the
// content check, the scanner's result, the copy to uploads/). Locally, until
// the worker has its file-check job, A2H_E2E_FILE_CHECK_STANDIN=1 starts this
// stand-in inside the test process: it plays the worker's part on the local
// database and the local S3 (LocalStack) and nothing else. It is NOT the
// worker's logic: it only marks a file whose object reached tmp/ as checking,
// then either refuses it (`malware`, when its bytes hold the EICAR test
// string) and deletes it, or copies it to uploads/ and marks it ready. It
// never runs against a deployed stage (it needs the database URL and the S3
// endpoint of a local server).
//
//   A2H_E2E_FILE_CHECK_STANDIN=1
//   A2H_E2E_DATABASE_URL    the local server's DATABASE_URL
//   A2H_E2E_S3_ENDPOINT     the local server's S3_ENDPOINT
//   A2H_E2E_S3_BUCKET       the local server's UPLOADS_BUCKET
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { markFileChecking, markFileReady, refuseFile, type A2hDb } from "@a2h/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export const STANDIN = process.env["A2H_E2E_FILE_CHECK_STANDIN"] === "1";

export interface StandIn {
  stop(): Promise<void>;
}

export function startFileCheckStandIn(): StandIn {
  const url = process.env["A2H_E2E_DATABASE_URL"];
  const endpoint = process.env["A2H_E2E_S3_ENDPOINT"];
  const bucket = process.env["A2H_E2E_S3_BUCKET"];
  if (!url || !endpoint || !bucket) throw new Error("the file-check stand-in needs A2H_E2E_DATABASE_URL, A2H_E2E_S3_ENDPOINT and A2H_E2E_S3_BUCKET");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(endpoint)) throw new Error("the file-check stand-in runs against a local S3 only");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool) as unknown as A2hDb;
  const s3 = new S3Client({ endpoint, forcePathStyle: true, region: "eu-west-3", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  let stopped = false;

  const tick = async () => {
    const rows = (await pool.query<{ id: string; object_key: string; declared_type: string; state: string; checked_etag: string | null }>(
      "SELECT id, object_key, declared_type, state, checked_etag FROM request_files WHERE deleted_at IS NULL AND state IN ('uploading', 'checking')",
    )).rows;
    for (const r of rows) {
      let etag: string;
      try {
        etag = ((await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: r.object_key }))).ETag ?? "").replace(/^"(.*)"$/, "$1");
      } catch {
        continue; // not uploaded (yet)
      }
      // One pass to checking, the next to the outcome: the page shows "Checking" in between.
      if (r.state === "uploading") {
        await markFileChecking(db, r.id, r.declared_type, etag);
        continue;
      }
      if (!r.checked_etag) continue;
      const head = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: r.object_key, Range: "bytes=0-8191" }))).Body!.transformToString("latin1");
      if (head.includes(EICAR)) {
        const refused = await refuseFile(db, r.id, "malware");
        if (refused) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: refused.object_key }));
        continue;
      }
      const clean = r.object_key.replace(/^tmp\//, "uploads/");
      await s3.send(
        new CopyObjectCommand({ Bucket: bucket, Key: clean, CopySource: `${bucket}/${r.object_key}`, CopySourceIfMatch: `"${r.checked_etag}"`, ContentType: r.declared_type, MetadataDirective: "REPLACE" }),
      );
      if (await markFileReady(db, r.id, clean, new Date(), r.checked_etag)) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: r.object_key }));
    }
  };

  const loop = (async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!stopped) await tick().catch(() => undefined);
    }
  })();

  return {
    async stop() {
      stopped = true;
      await loop;
      await pool.end();
    },
  };
}
