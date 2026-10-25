// healthPathFor is the one derivation of the health path from MCP_BASE_PATH;
// infra/config.ts imports the same file (infra/test/config.test.ts checks
// that the ALB health check and the server agree).
import { test } from "node:test";
import assert from "node:assert/strict";
import { healthPathFor } from "../src/health-path.ts";

test("health path is MCP_BASE_PATH without /mcp, plus /healthz", () => {
  assert.equal(healthPathFor("/mcp"), "/healthz");
  assert.equal(healthPathFor("/pr-12/mcp"), "/pr-12/healthz");
  assert.equal(healthPathFor("/pr-12/mcp/"), "/pr-12/healthz");
});
