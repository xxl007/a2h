// The one derivation of the health path from MCP_BASE_PATH. Pure, no imports:
// infra/config.ts imports this file too, so the ALB health check and the
// server can never disagree (contract amendment 1, item 5).

/** `/mcp` -> `/healthz`, `/pr-12/mcp` -> `/pr-12/healthz`. */
export function healthPathFor(mcpBasePath: string): string {
  const trimmed = mcpBasePath.replace(/\/+$/, "");
  return `${trimmed.replace(/\/mcp$/, "")}/healthz`;
}
