// Spec: openspec/changes/m0-foundation/specs/platform/mcp-transport/spec.md
// Every scenario that can be proven in-process is proven here, against the
// real HTTP app and the official MCP client. "Idle stream survives" needs the
// deployed ALB (QA, task 5.4); the server-side half of it (Node timeouts and
// the ping hold) is covered in http.test.ts and below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, start, type Era } from "./helpers.ts";
import { pingJsonSchemas, toolJsonSchemas } from "@a2h/protocol";
import { PACKAGE_VERSION } from "../src/version.ts";

const A2H_TOOLS = ["find_humans", "request_human", "check_requests"] as const;

/** The policy every A2H tool description carries (spec mcp-transport "Tools are listed"). */
function assertPolicy(name: string, description: string): void {
  assert.match(description, /last resort/i, `${name}: a human is a last resort`);
  assert.match(description, /search, existing tools[^.]*come first/i, `${name}: search and existing tools come first`);
  assert.match(description, /shown the exact question[^.]*before anything is sent/i, `${name}: the question is shown to the principal before sending`);
  assert.match(description, /pays what clears, never more than the hold/i, `${name}: pays what clears, never more than the hold`);
}

const ERAS: Era[] = ["legacy", "modern"];

function firstText(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const item = content.find((c) => c.type === "text");
  assert.ok(item?.text !== undefined, "no text content item");
  return item.text;
}

for (const era of ERAS) {
  test(`[${era}] Initialize from a fresh client: capabilities and protocol version`, async () => {
    const s = await start();
    try {
      const client = await connect(`${s.origin}/mcp`, { era });
      try {
        assert.equal(client.getProtocolEra(), era);
        const version = client.getNegotiatedProtocolVersion();
        if (era === "modern") assert.equal(version, "2026-07-28");
        else assert.match(version ?? "", /^\d{4}-\d{2}-\d{2}$/);
        const caps = client.getServerCapabilities();
        assert.ok(caps?.tools, "server advertises the tools capability");
        assert.deepEqual(client.getServerVersion(), { name: "a2h", version: PACKAGE_VERSION });
      } finally {
        await client.close();
      }
    } finally {
      await s.stop();
    }
  });

  test(`[${era}] Tools are listed: find_humans, request_human, check_requests and ping, each with a description and an input schema`, async () => {
    const s = await start();
    try {
      const client = await connect(`${s.origin}/mcp`, { era });
      try {
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((t) => t.name).sort(), ["check_requests", "find_humans", "ping", "request_human"]);
        for (const t of tools) {
          assert.ok((t.description ?? "").trim().length > 0, `${t.name} has a description`);
          assert.equal(t.inputSchema.type, "object", `${t.name} has an object input schema`);
        }
        for (const name of A2H_TOOLS) {
          const description = tools.find((t) => t.name === name)!.description ?? "";
          assertPolicy(name, description);
        }
        const ping = tools.find((t) => t.name === "ping");
        assert.ok(ping, "ping is listed");
        assert.match(ping.description ?? "", /pong/);
        assert.match(ping.description ?? "", /stage/);
        assert.match(ping.description ?? "", /holdSeconds/);
        const hold = (ping.inputSchema.properties as Record<string, Record<string, unknown>>)[
          "holdSeconds"
        ];
        assert.ok(hold, "holdSeconds is in the input schema");
        assert.equal(hold["type"], "integer");
        assert.equal(hold["minimum"], 0);
        assert.equal(hold["maximum"], 3900);
        assert.ok(!(ping.inputSchema.required ?? []).includes("holdSeconds"));
      } finally {
        await client.close();
      }
    } finally {
      await s.stop();
    }
  });

  test(`[${era}] Scenario: Tool schemas come from the export: every tool's input and output schemas equal the protocol export, field for field`, async () => {
    const s = await start();
    try {
      const client = await connect(`${s.origin}/mcp`, { era });
      try {
        const { tools } = await client.listTools();
        const exported = toolJsonSchemas();
        for (const name of A2H_TOOLS) {
          const tool = tools.find((t) => t.name === name)!;
          assert.deepEqual(tool.inputSchema, exported[name].input, `${name} input schema`);
          assert.deepEqual(tool.outputSchema, exported[name].output, `${name} output schema`);
        }
        // ping too (review N6): its input from the export, no output schema on either side.
        const ping = tools.find((t) => t.name === "ping")!;
        assert.deepEqual(ping.inputSchema, pingJsonSchemas().input, "ping input schema");
        assert.equal(ping.outputSchema, undefined);
      } finally {
        await client.close();
      }
    } finally {
      await s.stop();
    }
  });

  test(`[${era}] ping is called: text starts with pong, names the stage, not an error`, async () => {
    const s = await start({ stage: "pr-12", mcpBasePath: "/pr-12/mcp" });
    try {
      const client = await connect(`${s.origin}/pr-12/mcp`, { era });
      try {
        const result = await client.callTool({ name: "ping" });
        assert.ok(!result.isError);
        const text = firstText(result);
        assert.ok(text.startsWith("pong"), text);
        assert.equal(text, "pong from stage pr-12");
      } finally {
        await client.close();
      }
    } finally {
      await s.stop();
    }
  });

  test(`[${era}] Requests hit different instances: consecutive requests alternate between two servers`, async () => {
    const a = await start();
    const b = await start();
    const served: Array<{ origin: string; method: string }> = [];
    const sessionHeaders: string[] = [];
    let next = 0;
    // Round-robin load balancer in front of two independent instances: every
    // HTTP request from the one client goes to the other instance than the
    // previous one.
    const roundRobin = async (input: string | URL, init?: RequestInit) => {
      const target = [a.origin, b.origin][next++ % 2]!;
      const url = new URL(input.toString());
      const rewritten = `${target}${url.pathname}${url.search}`;
      let method = init?.method ?? "GET";
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body) as { method?: string } | Array<{ method?: string }>;
        method = Array.isArray(body) ? "batch" : (body.method ?? "response");
      }
      served.push({ origin: target, method });
      const res = await fetch(rewritten, init);
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionHeaders.push(sid);
      return res;
    };
    try {
      const client = await connect(`${a.origin}/mcp`, { era, fetch: roundRobin });
      try {
        const first = await client.callTool({ name: "ping" });
        const second = await client.callTool({ name: "ping" });
        assert.ok(!first.isError && !second.isError);
        assert.ok(firstText(first).startsWith("pong"));
        assert.ok(firstText(second).startsWith("pong"));
        const calls = served.filter((r) => r.method === "tools/call");
        assert.equal(calls.length, 2);
        assert.notEqual(calls[0]!.origin, calls[1]!.origin, "the two calls hit different instances");
        assert.deepEqual(sessionHeaders, [], "no Mcp-Session-Id is ever issued");
      } finally {
        await client.close();
      }
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test(`[${era}] ping holdSeconds: waits, sends nothing, then returns pong`, async () => {
    const s = await start();
    try {
      const client = await connect(`${s.origin}/mcp`, { era });
      try {
        const started = performance.now();
        const result = await client.callTool({ name: "ping", arguments: { holdSeconds: 2 } });
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 2000, `took ${elapsed} ms`);
        assert.ok(!result.isError);
        assert.equal(firstText(result), "pong from stage test");
      } finally {
        await client.close();
      }
    } finally {
      await s.stop();
    }
  });
}

test("ping rejects holdSeconds outside 0..3900 or not an integer", async () => {
  const s = await start();
  try {
    const client = await connect(`${s.origin}/mcp`, { era: "modern" });
    try {
      for (const holdSeconds of [-1, 3901, 1.5]) {
        let failed = false;
        try {
          const result = await client.callTool({ name: "ping", arguments: { holdSeconds } });
          failed = result.isError === true;
        } catch {
          failed = true;
        }
        assert.ok(failed, `holdSeconds ${holdSeconds} must be refused`);
      }
    } finally {
      await client.close();
    }
  } finally {
    await s.stop();
  }
});

test("held ping response stays silent until the result (no bytes before pong)", async () => {
  // The idle-stream scenario needs a response on which nothing is sent for
  // the whole hold: a raw legacy POST shows the body arrives only at the end.
  const s = await start();
  try {
    const started = performance.now();
    const res = await fetch(`${s.origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ping", arguments: { holdSeconds: 1 } },
      }),
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const firstChunk = await reader.read();
    const firstByteAt = performance.now() - started;
    assert.ok(firstByteAt >= 1000, `first body bytes after ${firstByteAt} ms`);
    let text = new TextDecoder().decode(firstChunk.value);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /pong from stage test/);
  } finally {
    await s.stop();
  }
});
