// Entry point of the A2H MCP service (ECS Fargate behind the shared ALB).
// Env (infra/service-env.ts): PORT, STAGE, and what the deployment adapter
// reads (infra/env.ts): MCP_BASE_PATH, the database, the approval key,
// FEE_RATE, CLEARING_SHARE, the resource server's settings and the limits.
import { mcpConfigFromEnv } from "../infra/env.ts";
import { createApp, type LogLine } from "./app.ts";
import { openDatabase } from "./db.ts";
import { healthPathFor } from "./health-path.ts";
import { PACKAGE_VERSION } from "./version.ts";

const port = Number(process.env.PORT ?? 3000);
const stage = process.env.STAGE ?? "local";

const log = (line: LogLine) => console.log(JSON.stringify({ ...line, stage }));

let config;
try {
  config = mcpConfigFromEnv();
} catch (error: unknown) {
  // The adapter's messages name variables, never values.
  log({ level: "error", msg: "mcp server failed to start", error: error instanceof Error ? error.name : "unknown", detail: error instanceof Error ? error.message : undefined });
  process.exit(1);
}

const mcpBasePath = config.mcpBasePath;
const database = openDatabase(config.db);
const app = createApp({
  stage,
  mcpBasePath,
  log,
  auth: config.auth,
  pingMaxConcurrent: config.pingMaxConcurrent,
  a2h: {
    db: database.db,
    feeRate: config.feeRate,
    clearingShare: config.clearingShare,
    approvalKey: config.approvalKey,
    limits: config.limits,
  },
});

app.server.listen(port, () => {
  log({
    level: "info",
    msg: "mcp server listening",
    port,
    mcp_path: mcpBasePath,
    health_path: healthPathFor(mcpBasePath),
    auth_required: config.auth.required,
    ping_open: config.auth.pingOpen,
    version: PACKAGE_VERSION,
  });
});

// ECS sends SIGTERM and kills the task 30 s later (default stopTimeout).
// The ALB deregistration delay has already drained new traffic; give
// in-flight requests 20 s, then end the rest and exit well inside 30 s.
const SHUTDOWN_GRACE_MS = 20_000;
let shuttingDown = false;

process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ level: "info", msg: "shutting down" });
  app
    .shutdown(SHUTDOWN_GRACE_MS)
    .then(() => database.close())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        log({ level: "error", msg: "shutdown failed", error: error instanceof Error ? error.name : "unknown" });
        process.exit(1);
      },
    );
});
