// MCP contract tests against a live stage. One test per scenario of
// openspec/changes/m0-foundation/specs/platform/mcp-transport/spec.md
// (the idle-stream scenario is in idle-stream.test.ts, opt-in).
// Run: A2H_MCP_URL=http://<alb>/pr-<n>/mcp pnpm --filter @a2h/tests contract
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { toolJsonSchemas } from "@a2h/protocol";
import { expectedStage, gateExpectation, healthUrl, mcpUrl, metadataUrl } from "../src/live-env.ts";
import { PROTOCOL_VERSION, connectFresh, recordingFetch, type Exchange } from "./mcp-client.ts";

// Fails the whole file with a clear message when A2H_MCP_URL is unset.
const MCP_URL = mcpUrl();
const STAGE = expectedStage(MCP_URL);
// m1-hosted-connector: what infra configures for this stage's gate (AUTH_REQUIRED, PING_OPEN).
const GATE = await gateExpectation(STAGE);

function assertNoSession(exchanges: Exchange[], who: string): void {
  assert.ok(exchanges.length > 0, `${who}: no HTTP exchange was recorded`);
  for (const [i, e] of exchanges.entries()) {
    assert.equal(e.requestSessionId, null, `${who}: request ${i} (${e.rpcMethods.join(",")}) sent Mcp-Session-Id`);
    assert.equal(e.responseSessionId, null, `${who}: response ${i} (${e.rpcMethods.join(",")}) set Mcp-Session-Id`);
  }
}

function assertPong(result: CallToolResult, who: string): void {
  assert.ok(!result.isError, `${who}: ping result is marked isError: ${JSON.stringify(result)}`);
  const first = result.content[0];
  assert.ok(first && first.type === "text", `${who}: first content item is not text: ${JSON.stringify(result.content)}`);
  assert.ok(first.text.startsWith("pong"), `${who}: text does not start with "pong": ${JSON.stringify(first.text)}`);
  assert.ok(first.text.includes(STAGE), `${who}: text does not name stage "${STAGE}": ${JSON.stringify(first.text)}`);
}

test(`[${MCP_URL.href}] Scenario: Initialize from a fresh client`, async () => {
  const { client, transport, exchanges, close } = await connectFresh();
  try {
    // 2026-07-28 replaces the `initialize` handshake with `server/discover`;
    // the pinned client fails to connect unless the server offers that revision.
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), PROTOCOL_VERSION);
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities, "server capabilities missing after connect");
    assert.ok(capabilities.tools, `server does not advertise tools: ${JSON.stringify(capabilities)}`);
    assert.equal(transport.sessionId, undefined, "transport holds a session id after connect");
    assertNoSession(exchanges, "handshake");
  } finally {
    await close();
  }
});

// m1-protocol-connector (modified scenario): the three A2H tools are listed
// next to ping, and each A2H description carries the policy text.
const A2H_TOOLS = ["find_humans", "request_human", "check_requests"] as const;

test("Scenario: Tools are listed", async () => {
  const { client, close } = await connectFresh();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [...A2H_TOOLS, "ping"]) assert.ok(names.includes(name), `no tool named ${name} in ${JSON.stringify(names)}`);
    for (const t of tools) {
      assert.ok(t.description && t.description.trim().length > 0, `${t.name} has an empty description`);
      assert.equal(t.inputSchema.type, "object", `${t.name} input schema is not an object`);
    }
    for (const name of A2H_TOOLS) {
      const d = tools.find((t) => t.name === name)?.description ?? "";
      assert.match(d, /last resort/i, `${name}: a human is a last resort`);
      assert.match(d, /search, existing tools[^.]*come first/i, `${name}: search and existing tools come first`);
      assert.match(d, /shown the exact question[^.]*before anything is sent/i, `${name}: the question is shown to the principal before sending`);
      assert.match(d, /pays what clears, never more than the hold/i, `${name}: the principal pays what clears, never more than the hold`);
    }
    const ping = tools.find((t) => t.name === "ping");
    assert.ok(ping, `no tool named ping in ${JSON.stringify(tools.map((t) => t.name))}`);
    assert.equal(typeof ping.description, "string");
    assert.ok(ping.description && ping.description.trim().length > 0, "ping has an empty description");
    assert.equal(ping.inputSchema.type, "object");
    // Contract: optional integer holdSeconds, 0..3900 (used by the idle-stream test).
    const hold = ping.inputSchema.properties?.holdSeconds as Record<string, unknown> | undefined;
    assert.ok(hold, `ping input schema has no holdSeconds: ${JSON.stringify(ping.inputSchema)}`);
    assert.equal(hold.type, "integer");
    assert.equal(hold.minimum, 0);
    assert.equal(hold.maximum, 3900);
    assert.ok(!(ping.inputSchema.required ?? []).includes("holdSeconds"), "holdSeconds must be optional");
  } finally {
    await close();
  }
});

// protocol/schemas "Tool schemas come from the export", checked on the
// deployed stage too: what tools/list serves is the protocol package's JSON
// Schema export, unchanged (in-process: apps/mcp/test/mcp-transport.test.ts).
test("Scenario: Tool schemas come from the export (deployed stage)", async () => {
  const { client, close } = await connectFresh();
  try {
    const { tools } = await client.listTools();
    const exported = toolJsonSchemas();
    for (const name of A2H_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `no tool named ${name}`);
      assert.deepEqual(tool.inputSchema, exported[name].input, `${name} input schema`);
      assert.deepEqual(tool.outputSchema, exported[name].output, `${name} output schema`);
    }
  } finally {
    await close();
  }
});

test("Scenario: ping is called", async () => {
  const { client, close } = await connectFresh();
  try {
    // "no arguments": the request carries no `arguments` member at all.
    const result = await client.callTool({ name: "ping" });
    assertPong(result, "ping");
  } finally {
    await close();
  }
});

test("Scenario: Requests hit different instances (five fresh clients in a row, no session header)", async () => {
  for (let i = 1; i <= 5; i += 1) {
    const { client, transport, exchanges, close } = await connectFresh();
    try {
      const result = await client.callTool({ name: "ping" });
      assertPong(result, `client ${i}`);
      assert.equal(transport.sessionId, undefined, `client ${i}: transport holds a session id`);
      assertNoSession(exchanges, `client ${i}`);
    } finally {
      await close();
    }
  }
});

test("Scenario: Requests hit different instances (tools/call is the first request a brand-new client sends)", async () => {
  // Client A discovers; client B adopts A's discover result (zero round
  // trips at connect), so B's very first HTTP request is tools/call. The
  // server cannot rely on anything it saw from B before.
  const a = await connectFresh();
  const discover = a.client.getDiscoverResult();
  await a.close();
  assert.ok(discover, "client A has no discover result (not a 2026-07-28 connection)");

  const b = await connectFresh({ prior: discover });
  try {
    assert.equal(b.exchanges.length, 0, `client B sent requests at connect: ${JSON.stringify(b.exchanges)}`);
    const result = await b.client.callTool({ name: "ping" });
    assertPong(result, "client B");
    assert.deepEqual(b.exchanges[0]?.rpcMethods, ["tools/call"], "client B's first request was not tools/call");
    assertNoSession(b.exchanges, "client B");
  } finally {
    await b.close();
  }
});

test("Scenario: Load balancer probes health", async () => {
  const url = healthUrl(MCP_URL);
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  await response.arrayBuffer();
  const elapsed = performance.now() - started;
  assert.equal(response.status, 200, `${url.href} returned ${response.status}`);
  assert.ok(elapsed < 1_000, `${url.href} took ${Math.round(elapsed)} ms (limit 1000 ms)`);
  assert.equal(response.headers.get("mcp-session-id"), null, "health response set Mcp-Session-Id");
});

// m1-hosted-connector (modified requirement): with the gate on, a handshake
// without a token is challenged before any MCP message is read, unless the
// stage opens the handshake, tools/list and ping (PING_OPEN, dev and previews
// for QA; design D3). The expectation is the stage's configuration.
test(`Scenario: Handshake without a token (${STAGE}: AUTH_REQUIRED=${GATE.authRequired}, PING_OPEN=${GATE.pingOpen})`, { skip: GATE.authRequired ? false : `AUTH_REQUIRED=false on ${STAGE}: the gate is off by configuration` }, async () => {
  const challenge = `Bearer resource_metadata="${metadataUrl(MCP_URL).href}", scope="a2h"`;
  for (const body of [
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} },
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } },
  ]) {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (GATE.pingOpen) {
      assert.equal(res.status, 200, `${body.method}: an open handshake must be admitted on ${STAGE}`);
    } else {
      assert.equal(res.status, 401, `${body.method}: HTTP ${res.status}`);
      assert.equal(res.headers.get("www-authenticate"), challenge, body.method);
      assert.equal(text, "", `${body.method}: capabilities returned without a token`);
    }
  }
  // The official client, tokenless: connects only where the handshake is open.
  if (GATE.pingOpen) {
    const { client, close } = await connectFresh({ token: null });
    try {
      assert.ok(client.getServerCapabilities()?.tools);
    } finally {
      await close();
    }
  } else {
    await assert.rejects(connectFresh({ token: null }), /HTTP 401/);
  }
});

// Not a spec scenario. MCP Inspector and older clients connect with the 2025
// `initialize` handshake; this reports whether the server still accepts it,
// without failing the run (todo). The PM decides whether it becomes a rule.
test("Compat (informational): legacy initialize handshake", { todo: "not in the spec; reported for the PM" }, async () => {
  const { fetch, exchanges } = recordingFetch();
  const client = new Client({ name: "a2h-contract-tests-legacy", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(MCP_URL, { fetch }), { timeout: 10_000 });
  try {
    assert.equal(client.getProtocolEra(), "legacy");
    const result = await client.callTool({ name: "ping" });
    assertPong(result, "legacy client");
    assertNoSession(exchanges, "legacy client");
  } finally {
    await client.close();
  }
});
