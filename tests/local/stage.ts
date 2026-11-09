// A local, preview-like A2H stage for running the live suites (contract,
// adversarial) without a deploy: PostgreSQL 17 in Docker set up as a preview
// (login pr_12 owning pr_12 and pr_12_jobs, real migrations, real simulated
// seed), the real MCP HTTP app in-process at /pr-12/mcp, and the real worker
// (deliver, simulate with the seed's persona delays, expire). QA tooling only:
// nothing here is deployed, and it reuses the apps' own test harnesses.
// The bearer gate is off by default here (AUTH_REQUIRED=false, the Migration
// Plan rollback path; every deployed stage runs it on since PR #60): every
// call acts for the seeded fallback principal dev-principal-pr-12. With A2H_LOCAL_AUTH=1
// (m1-hosted-connector task 9.2) the gate is on: a test authorization server
// (apps/mcp/test/lib/auth-server.ts) publishes the keys, two principals
// user-a and user-b exist, and the stage prints the environment the live
// suites take: A2H_TOKEN, A2H_TOKEN_2, A2H_TOKEN_NOSCOPE, A2H_EXPIRED_TOKEN,
// A2H_ISSUER, A2H_AUTH_REQUIRED=true, A2H_PING_OPEN (A2H_LOCAL_PING_OPEN,
// default true here; deployed stages run PING_OPEN=false since PR #60, so set
// A2H_LOCAL_PING_OPEN=false to rehearse them). Local tokens only: nothing here
// reaches a deployed stage.
//
//   node tests/local/stage.ts                # prints A2H_MCP_URL, runs until Ctrl-C
//   A2H_LOCAL_NOW=2026-10-29T23:00:00Z node tests/local/stage.ts
//       pins the MCP server's clock (approval-time validation: quiet hours,
//       interruptions per UTC day); the worker keeps the real clock.
//   A2H_LOCAL_AUTH=1 node tests/local/stage.ts
//       the gate on; prints the token lines above (export them for the suites)
//   A2H_LOCAL_AUTH=1 A2H_LOCAL_ISSUER=http://localhost:3210/api/auth node tests/local/stage.ts
//       the gate on behind a real authorization server (a local `next start` of
//       apps/web on this stage's database, printed as A2H_LOCAL_DATABASE_URL):
//       no test tokens; sign in through tests/lib/obtain-token.ts instead
//
//   A2H_LOCAL_FILES=1 A2H_LOCAL_WEB_URL=http://localhost:3210 node tests/local/stage.ts
//       files (m2-attachments): LocalStack S3 and SQS in Docker (the uploads
//       bucket with POST-only CORS for the web origin, the stage's file-events
//       queue), the real worker's file jobs on them through its real S3 store
//       and SQS adapter, and a fake scanner (local/fake-scanner.ts) as the
//       only stand-in: it writes the "Object Created" and GuardDuty result
//       events AWS would. Prints A2H_LOCAL_S3_ENDPOINT and
//       A2H_LOCAL_UPLOADS_BUCKET for the local `next start` (S3_ENDPOINT,
//       UPLOADS_BUCKET). A2H_LOCAL_WEB_URL is where that local web app runs
//       (the bucket's CORS origin). Approval links keep naming
//       https://web.a2h.test (request_human issues https links only); the
//       suites open them on A2H_LOCAL_WEB_URL (tests/lib/approval-page.ts
//       `localLink`).
//   A2H_LOCAL_CORS=0: the bucket without CORS (a preview today: the browser
//       cannot upload). A2H_LOCAL_SCANNER=0: no fake scanner (storage
//       without checks: no event, no result). Both for the gating runs.
//   A2H_LOCAL_LOG_FILE=<path>: every MCP and worker log line is also
//       appended there (the local check of spec "Logs of an upload").
//
// The Postgres and LocalStack containers are removed on exit (SIGINT, SIGTERM).
import { appendFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { createApp, type LogLine } from "../../apps/mcp/src/app.ts";
import { openDatabase } from "../../apps/mcp/src/db.ts";
import { startAuthServer, type TestAuthServer } from "../../apps/mcp/test/lib/auth-server.ts";
import { SqsFileEvents, sqsQueueClient } from "../../apps/worker/infra/file-events.ts";
import { S3FileStore } from "../../apps/worker/infra/s3-store.ts";
import { startWorker, type RunningWorker, type WorkerFiles } from "../../apps/worker/src/worker.ts";
import { startFakeScanner, type FakeScanner } from "./fake-scanner.ts";
import { startLocalStorage, type LocalStorage } from "./localstack.ts";
import { addPrincipal, PRINCIPAL_ID, STAGE, startStageDb, testConfig, testSigningKey } from "../../apps/worker/test/lib/stage-db.ts";

const pinned = process.env["A2H_LOCAL_NOW"]?.trim();
const pinnedAt = pinned ? new Date(pinned) : undefined;
if (pinnedAt && Number.isNaN(pinnedAt.getTime())) throw new Error(`A2H_LOCAL_NOW is not a date: ${pinned}`);
const quiet = process.env["A2H_LOCAL_QUIET"] === "1";
const authOn = process.env["A2H_LOCAL_AUTH"] === "1";
const pingOpen = (process.env["A2H_LOCAL_PING_OPEN"] ?? "true") === "true";
const filesOn = process.env["A2H_LOCAL_FILES"] === "1";
const localWebUrl = (process.env["A2H_LOCAL_WEB_URL"]?.trim() || "http://localhost:3210").replace(/\/$/, "");
const logFile = process.env["A2H_LOCAL_LOG_FILE"]?.trim();
const STORAGE_PREFIX = `${STAGE}/`;

const stage = await startStageDb();
const config = testConfig(stage.db, { signing: testSigningKey(`a2h-${STAGE}-local000000001`) });
const database = openDatabase({ connectionString: stage.db.connectionString, schema: stage.db.schema, ssl: false });
const mcpLogs: LogLine[] = [];

// The port first: with the gate on, the resource URL (the only audience accepted) names it.
const requestedPort = Number(process.env["A2H_LOCAL_PORT"] ?? 0);
const probe = net.createServer();
await new Promise<void>((resolve) => probe.listen(requestedPort, "127.0.0.1", resolve));
const port = (probe.address() as AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const resourceUrl = `http://127.0.0.1:${port}/${STAGE}/mcp`;

const externalIssuer = process.env["A2H_LOCAL_ISSUER"]?.trim().replace(/\/$/, "");
let authServer: TestAuthServer | undefined;
if (authOn && !externalIssuer) {
  authServer = await startAuthServer();
  // As consent creates them on a deployed stage (packages/db ensurePrincipal):
  // people, verified by the owner's allow-list. Not organisations, or the local
  // run would pass where a preview refuses (organisation-only personas, PR #60).
  await addPrincipal(stage.admin, "user-a", "real_name");
  await addPrincipal(stage.admin, "user-b", "real_name");
}
const issuer = externalIssuer ?? authServer?.issuer;
const jwksUrl = externalIssuer ? `${externalIssuer}/jwks` : authServer?.jwksUrl;

const app = createApp({
  stage: STAGE,
  mcpBasePath: `/${STAGE}/mcp`,
  log: (line) => {
    mcpLogs.push(line);
    if (logFile) appendFileSync(logFile, `mcp ${JSON.stringify(line)}\n`);
    if (!quiet) process.stdout.write(`mcp ${JSON.stringify(line)}\n`);
  },
  auth: authOn && issuer && jwksUrl
    ? { required: true, issuer, jwksUrl, resourceUrl, pingOpen }
    : {
        required: false,
        issuer: "http://127.0.0.1:1/api/auth",
        jwksUrl: "http://127.0.0.1:1/api/auth/jwks",
        resourceUrl,
        pingOpen: true,
      },
  fallbackPrincipalId: PRINCIPAL_ID,
  pingMaxConcurrent: 4,
  a2h: {
    db: database.db,
    feeRate: config.feeRate,
    // A preview's limits (infra/config.ts limitsFor).
    limits: { perMinute: 600, perDay: 20000 },
    clearingShare: config.clearingShare,
    approvalKey: Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff),
    webOrigin: "https://web.a2h.test",
    ...(pinnedAt ? { now: () => new Date(pinnedAt.getTime() + (Date.now() - started)) } : {}),
  },
});
const started = Date.now();
await new Promise<void>((resolve) => app.server.listen(port, "127.0.0.1", resolve));

const workerLog = (line: object) => {
  if (logFile) appendFileSync(logFile, `worker ${JSON.stringify(line)}\n`);
  if (!quiet) process.stdout.write(`worker ${JSON.stringify(line)}\n`);
};

let storage: LocalStorage | undefined;
let scanner: FakeScanner | undefined;
let files: WorkerFiles | undefined;
if (filesOn) {
  storage = await startLocalStorage({ webOrigin: localWebUrl, cors: process.env["A2H_LOCAL_CORS"] !== "0" });
  files = {
    store: new S3FileStore(storage.s3, storage.bucket),
    events: new SqsFileEvents(sqsQueueClient(storage.sqs, storage.queueUrl), { bucket: storage.bucket, storagePrefix: STORAGE_PREFIX }, workerLog, { errorBackoffMs: 1000 }),
    storagePrefix: STORAGE_PREFIX,
    scanRetryDelaySeconds: 2,
  };
  if (process.env["A2H_LOCAL_SCANNER"] !== "0") scanner = startFakeScanner({ s3: storage.s3, sqs: storage.sqs, bucket: storage.bucket, queueUrl: storage.queueUrl, prefix: `tmp/${STORAGE_PREFIX}files/`, log: workerLog });
}

let worker: RunningWorker | undefined = await startWorker({ config, log: workerLog, ...(files ? { files } : {}) });

if (storage) process.stdout.write(`A2H_LOCAL_S3_ENDPOINT=${storage.endpoint}\nA2H_LOCAL_UPLOADS_BUCKET=${storage.bucket}\nA2H_LOCAL_STORAGE_PREFIX=${STORAGE_PREFIX}\n`);
process.stdout.write(`A2H_MCP_URL=${resourceUrl}${pinnedAt ? ` (MCP clock pinned at ${pinnedAt.toISOString()})` : ""}\n`);
if (authOn) {
  // The stage's database as login pr_12 (search_path resolves to pr_12), for a local apps/web on the same rows.
  process.stdout.write(`A2H_LOCAL_DATABASE_URL=${stage.db.connectionString}\n`);
  process.stdout.write(`A2H_ISSUER=${issuer}\nA2H_AUTH_REQUIRED=true\nA2H_PING_OPEN=${String(pingOpen)}\n`);
}
if (authServer) {
  const now = Math.floor(Date.now() / 1000);
  const mint = (claims: Record<string, unknown>) => authServer.mint({ aud: resourceUrl, ...claims });
  const lines = {
    A2H_TOKEN: await mint({ sub: "user-a" }),
    A2H_TOKEN_2: await mint({ sub: "user-b" }),
    A2H_TOKEN_NOSCOPE: await mint({ sub: "user-a", scope: "offline_access" }),
    A2H_EXPIRED_TOKEN: await mint({ sub: "user-a", exp: now - 60 }),
    // Signed by the same authorization server for another resource: the audience check alone must refuse it.
    A2H_TOKEN_OTHER_AUD: await mint({ sub: "user-a", aud: `http://127.0.0.1:${port}/other/mcp` }),
  };
  for (const [k, v] of Object.entries(lines)) process.stdout.write(`${k}=${v}\n`);
}

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await scanner?.stop().catch(() => undefined);
  await worker?.stop().catch(() => undefined);
  worker = undefined;
  await files?.events.stop().catch(() => undefined);
  await storage?.stop().catch(() => undefined);
  await app.shutdown(1000).catch(() => undefined);
  await database.close().catch(() => undefined);
  await authServer?.stop().catch(() => undefined);
  await stage.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
