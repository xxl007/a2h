// Entry point of the A2H MCP service (ECS Fargate behind the shared ALB).
// Env (infra/README.md): PORT, STAGE, MCP_BASE_PATH.
import { createApp, type LogLine } from "./app.ts";
import { healthPathFor } from "./health-path.ts";
import { PACKAGE_VERSION } from "./version.ts";

const port = Number(process.env.PORT ?? 3000);
const stage = process.env.STAGE ?? "local";
const mcpBasePath = process.env.MCP_BASE_PATH ?? "/mcp";

const log = (line: LogLine) => console.log(JSON.stringify({ ...line, stage }));

const app = createApp({ stage, mcpBasePath, log });

app.server.listen(port, () => {
  log({
    level: "info",
    msg: "mcp server listening",
    port,
    mcp_path: mcpBasePath,
    health_path: healthPathFor(mcpBasePath),
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
  app.shutdown(SHUTDOWN_GRACE_MS).then(
    () => process.exit(0),
    (error: unknown) => {
      log({ level: "error", msg: "shutdown failed", error: error instanceof Error ? error.name : "unknown" });
      process.exit(1);
    },
  );
});
