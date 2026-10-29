// The HTTP shell around the MCP handler: health, routing, Node timeouts,
// request logging, graceful shutdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import { connect, start } from "./helpers.ts";
import { createMcpServer } from "../src/mcp-server.ts";
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS } from "../src/http-timeouts.ts";

test("Load balancer probes health: 200 {ok:true} within one second, no MCP state created", async () => {
  let created = 0;
  const factory: McpServerFactory = () => {
    created++;
    return createMcpServer("test");
  };
  const s = await start({ factory });
  try {
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const res = await fetch(`${s.origin}/healthz`);
      const elapsed = performance.now() - started;
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(await res.json(), { ok: true });
      assert.ok(elapsed < 1000, `health took ${elapsed} ms`);
    }
    assert.equal(created, 0, "health never builds an MCP server");
    // Sanity: the counter does count MCP traffic.
    const client = await connect(`${s.origin}/mcp`);
    await client.callTool({ name: "ping" });
    await client.close();
    assert.ok(created > 0);
  } finally {
    await s.stop();
  }
});

test("health answers HEAD too, and refuses other methods", async () => {
  const s = await start();
  try {
    assert.equal((await fetch(`${s.origin}/healthz`, { method: "HEAD" })).status, 200);
    const post = await fetch(`${s.origin}/healthz`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  } finally {
    await s.stop();
  }
});

test("unknown paths answer 404 JSON", async () => {
  const s = await start();
  try {
    for (const path of ["/", "/mcpx", "/mcp/extra", "/pr-12/mcp", "/pr-12/healthz", "/healthz/x"]) {
      const res = await fetch(`${s.origin}${path}`, { method: "POST", body: "{}" });
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/, path);
      assert.deepEqual(await res.json(), { error: "not_found" }, path);
    }
  } finally {
    await s.stop();
  }
});

test("MCP_BASE_PATH=/pr-12/mcp: MCP and health live under the prefix only", async () => {
  const s = await start({ stage: "pr-12", mcpBasePath: "/pr-12/mcp" });
  try {
    assert.equal((await fetch(`${s.origin}/pr-12/healthz`)).status, 200);
    assert.equal((await fetch(`${s.origin}/pr-12/healthz?probe=1`)).status, 200);
    assert.equal((await fetch(`${s.origin}/healthz`)).status, 404);
    assert.equal((await fetch(`${s.origin}/mcp`, { method: "POST", body: "{}" })).status, 404);
    const client = await connect(`${s.origin}/pr-12/mcp`);
    const result = await client.callTool({ name: "ping" });
    await client.close();
    assert.ok(!result.isError);
  } finally {
    await s.stop();
  }
});

test("Node HTTP timeouts let a 61-minute idle response live", async () => {
  const s = await start();
  try {
    // requestTimeout 0: Node's default (300 s) would kill the held ping.
    assert.equal(s.app.server.requestTimeout, 0);
    // keep-alive above the ALB idle timeout (4000 s) so the ALB, not Node,
    // closes idle keep-alive connections; headers timeout above keep-alive.
    assert.equal(KEEP_ALIVE_TIMEOUT_MS, 4_010_000);
    assert.equal(s.app.server.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
    assert.ok(HEADERS_TIMEOUT_MS > KEEP_ALIVE_TIMEOUT_MS);
    assert.equal(s.app.server.headersTimeout, HEADERS_TIMEOUT_MS);
    // No socket inactivity timeout either.
    assert.equal(s.app.server.timeout, 0);
  } finally {
    await s.stop();
  }
});

test("one JSON log line per request: method, path, status, duration, request id; no body, no query", async () => {
  const s = await start();
  try {
    await fetch(`${s.origin}/healthz?email=someone@example.com`, {
      headers: { "x-request-id": "req-abc-123" },
    });
    const res = await fetch(`${s.origin}/nope`);
    const generated = res.headers.get("x-request-id");
    assert.match(generated ?? "", /^[0-9a-f-]{36}$/, "a request id is generated and echoed");

    const client = await connect(`${s.origin}/mcp`);
    await client.callTool({ name: "ping", arguments: { holdSeconds: 0 } });
    await client.close();
    // Logs are written on response finish; let the last one land.
    await new Promise((r) => setTimeout(r, 50));

    const requests = s.logs.filter((l) => l.msg === "request");
    assert.equal(requests[0]?.http_request_id, "req-abc-123");
    assert.equal(requests[0]?.path, "/healthz");
    assert.equal(requests[0]?.method, "GET");
    assert.equal(requests[0]?.status, 200);
    assert.equal(typeof requests[0]?.duration_ms, "number");
    assert.equal(requests[1]?.http_request_id, generated);
    assert.equal(requests[1]?.status, 404);
    assert.ok(requests.some((l) => l.path === "/mcp" && l.method === "POST" && l.status === 200));
    for (const line of s.logs) {
      const raw = JSON.stringify(line);
      assert.doesNotMatch(raw, /example\.com|holdSeconds|tools\/call|jsonrpc/, raw);
      assert.deepEqual(
        Object.keys(line).filter((k) => !["level", "msg", "method", "path", "status", "duration_ms", "http_request_id", "stage"].includes(k)),
        [],
        raw,
      );
    }
  } finally {
    await s.stop();
  }
});

test("an unsafe x-request-id is replaced, not logged", async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.origin}/healthz`, { headers: { "x-request-id": "a".repeat(200) } });
    const id = res.headers.get("x-request-id") ?? "";
    assert.match(id, /^[0-9a-f-]{36}$/);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!JSON.stringify(s.logs).includes("a".repeat(200)));
  } finally {
    await s.stop();
  }
});

test("shutdown: health turns 503, listener closes, in-flight held ping is ended", async () => {
  const s = await start();
  const client = await connect(`${s.origin}/mcp`);
  const held = client
    .callTool({ name: "ping", arguments: { holdSeconds: 60 } })
    .then(() => "answered", () => "ended");
  await new Promise((r) => setTimeout(r, 200));
  const started = performance.now();
  const stopping = s.app.shutdown(300);
  const health = await fetch(`${s.origin}/healthz`).then((r) => r.status, () => "closed");
  assert.ok(health === 503 || health === "closed", `health during shutdown: ${health}`);
  await stopping;
  assert.ok(performance.now() - started < 5000, "shutdown is bounded by its grace period");
  assert.equal(s.app.server.listening, false);
  assert.equal(await held, "ended");
  await client.close();
});
