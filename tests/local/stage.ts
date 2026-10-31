// A local, preview-like A2H stage for running the live suites (contract,
// adversarial) without a deploy: PostgreSQL 17 in Docker set up as a preview
// (login pr_12 owning pr_12 and pr_12_jobs, real migrations, real simulated
// seed), the real MCP HTTP app in-process at /pr-12/mcp, and the real worker
// (deliver, simulate with the seed's persona delays, expire). QA tooling only:
// nothing here is deployed, and it reuses the apps' own test harnesses.
// The bearer gate is off (AUTH_REQUIRED=false, as on previews until task
// 8.3): every call acts for the seeded fallback principal dev-principal-pr-12.
//
//   node tests/local/stage.ts                # prints A2H_MCP_URL, runs until Ctrl-C
//   A2H_LOCAL_NOW=2026-10-29T23:00:00Z node tests/local/stage.ts
//       pins the MCP server's clock (approval-time validation: quiet hours,
//       interruptions per UTC day); the worker keeps the real clock.
//
// The Postgres container is removed on exit (SIGINT, SIGTERM).
import type { AddressInfo } from "node:net";
import { createApp, type LogLine } from "../../apps/mcp/src/app.ts";
import { openDatabase } from "../../apps/mcp/src/db.ts";
import { startWorker, type RunningWorker } from "../../apps/worker/src/worker.ts";
import { PRINCIPAL_ID, STAGE, startStageDb, testConfig, testSigningKey } from "../../apps/worker/test/lib/stage-db.ts";

const pinned = process.env["A2H_LOCAL_NOW"]?.trim();
const pinnedAt = pinned ? new Date(pinned) : undefined;
if (pinnedAt && Number.isNaN(pinnedAt.getTime())) throw new Error(`A2H_LOCAL_NOW is not a date: ${pinned}`);
const quiet = process.env["A2H_LOCAL_QUIET"] === "1";

const stage = await startStageDb();
const config = testConfig(stage.db, { signing: testSigningKey(`a2h-${STAGE}-local000000001`) });
const database = openDatabase({ connectionString: stage.db.connectionString, schema: stage.db.schema, ssl: false });
const mcpLogs: LogLine[] = [];
const app = createApp({
  stage: STAGE,
  mcpBasePath: `/${STAGE}/mcp`,
  log: (line) => {
    mcpLogs.push(line);
    if (!quiet) process.stdout.write(`mcp ${JSON.stringify(line)}\n`);
  },
  auth: {
    required: false,
    issuer: "http://127.0.0.1:1/api/auth",
    jwksUrl: "http://127.0.0.1:1/api/auth/jwks",
    resourceUrl: `http://127.0.0.1/${STAGE}/mcp`,
    pingOpen: true,
  },
  fallbackPrincipalId: PRINCIPAL_ID,
  pingMaxConcurrent: 4,
  a2h: {
    db: database.db,
    feeRate: config.feeRate,
    // A preview's limits (infra/service-env.ts STAGE_LIMITS.pr).
    limits: { perMinute: 600, perDay: 20000 },
    clearingShare: config.clearingShare,
    approvalKey: Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff),
    ...(pinnedAt ? { now: () => new Date(pinnedAt.getTime() + (Date.now() - started)) } : {}),
  },
});
const started = Date.now();
await new Promise<void>((resolve) => app.server.listen(Number(process.env["A2H_LOCAL_PORT"] ?? 0), "127.0.0.1", resolve));
const { port } = app.server.address() as AddressInfo;

let worker: RunningWorker | undefined = await startWorker({
  config,
  log: (line) => {
    if (!quiet) process.stdout.write(`worker ${JSON.stringify(line)}\n`);
  },
});

process.stdout.write(`A2H_MCP_URL=http://127.0.0.1:${port}/${STAGE}/mcp${pinnedAt ? ` (MCP clock pinned at ${pinnedAt.toISOString()})` : ""}\n`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await worker?.stop().catch(() => undefined);
  worker = undefined;
  await app.shutdown(1000).catch(() => undefined);
  await database.close().catch(() => undefined);
  await stage.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
