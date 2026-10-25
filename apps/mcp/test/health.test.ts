// Placeholder health listener for the first `dev` deploy (M0 step 4).
// Step 5 replaces it with the real MCP server under TDD.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHealthServer, healthPathFor } from "../src/health.ts";

test("health path is MCP_BASE_PATH without /mcp, plus /healthz", () => {
  assert.equal(healthPathFor("/mcp"), "/healthz");
  assert.equal(healthPathFor("/pr-12/mcp"), "/pr-12/healthz");
  assert.equal(healthPathFor("/pr-12/mcp/"), "/pr-12/healthz");
});

async function withServer(basePath: string, fn: (url: string) => Promise<void>) {
  const server = createHealthServer(basePath);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("answers 200 on the health path, 404 elsewhere", async () => {
  await withServer("/pr-12/mcp", async (url) => {
    const ok = await fetch(`${url}/pr-12/healthz`);
    assert.equal(ok.status, 200);
    const okWithQuery = await fetch(`${url}/pr-12/healthz?probe=1`);
    assert.equal(okWithQuery.status, 200);
    for (const path of ["/healthz", "/pr-12/mcp", "/", "/pr-13/healthz"]) {
      const res = await fetch(`${url}${path}`);
      assert.equal(res.status, 404, path);
    }
  });
});

test("health answers within one second (spec: Load balancer probes health)", async () => {
  await withServer("/mcp", async (url) => {
    const started = performance.now();
    const res = await fetch(`${url}/healthz`);
    assert.equal(res.status, 200);
    assert.ok(performance.now() - started < 1000);
  });
});
