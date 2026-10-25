// M0 placeholder entry point; step 5 replaces it with the MCP server.
import { createHealthServer, healthPathFor } from "./health.js";

const port = Number(process.env.PORT ?? 3000);
const basePath = process.env.MCP_BASE_PATH ?? "/mcp";
const server = createHealthServer(basePath);

server.listen(port, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "placeholder health listener started",
      port,
      healthPath: healthPathFor(basePath),
      stage: process.env.STAGE,
    }),
  );
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
