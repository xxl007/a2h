// Placeholder for the first `dev` deploy (M0 step 4): answers the ALB health
// check so the service stabilises. Step 5 replaces it with the MCP server.
import { createServer, type Server } from "node:http";
import { healthPathFor } from "./health-path.ts";

export { healthPathFor };

export function createHealthServer(mcpBasePath: string): Server {
  const healthPath = healthPathFor(mcpBasePath);
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const isProbe = (req.method === "GET" || req.method === "HEAD") && path === healthPath;
    res.writeHead(isProbe ? 200 : 404, { "content-type": "text/plain" });
    res.end(isProbe ? "ok" : "not found");
  });
}
