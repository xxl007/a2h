// THROWAWAY SPIKE ONLY, never merge (openspec/changes/m1-protocol-connector
// tasks.md 1.1, design.md D1). Proves the 2026-07-28 multi-round-trip approval
// path with an HMAC-protected requestState, statelessly.
//
// Runs in-process by default. With A2H_MCP_URL set it runs the same round
// trips against a deployed stage (task 1.2), and skips the in-process-only
// cases (two instances behind a fake balancer, the legacy shim).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, ProtocolError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, FetchLike } from "@modelcontextprotocol/client";
import { start, type Running } from "./helpers.ts";

const REMOTE = process.env["A2H_MCP_URL"];
const ORIGINAL = "Is the rail bridge at Nanterre open to road traffic tonight?";
const EDITED = "Is the rail bridge at Nanterre open to cars tonight, after 22:00? (é, «quotes»)";

interface Target {
  url: string;
  stop: () => Promise<void>;
}

async function target(): Promise<Target> {
  if (REMOTE) return { url: REMOTE, stop: async () => {} };
  const s: Running = await start();
  return { url: `${s.origin}/mcp`, stop: s.stop };
}

type ElicitAnswer = { action: "accept"; content: Record<string, string> } | { action: "decline" | "cancel" };

/** A modern (2026-07-28) client. `answer` makes it auto-fulfil elicitations; without it, manual mode. */
async function modernClient(url: string, answer?: (req: unknown) => ElicitAnswer, fetch?: FetchLike): Promise<Client> {
  const client = new Client(
    { name: "a2h-spike-test", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: { elicitation: { form: {} } },
      inputRequired: { autoFulfill: answer !== undefined },
    },
  );
  if (answer) client.setRequestHandler("elicitation/create", (req) => Promise.resolve(answer(req)));
  await client.connect(new StreamableHTTPClientTransport(new URL(url), fetch ? { fetch } : {}));
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  return client;
}

interface RawInputRequired {
  resultType: "input_required";
  inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
  requestState?: string;
}

async function firstRound(client: Client, text = ORIGINAL): Promise<RawInputRequired> {
  const raw = (await client.callTool(
    { name: "approve_test", arguments: { text } },
    { allowInputRequired: true },
  )) as unknown as RawInputRequired;
  assert.equal(raw.resultType, "input_required", `not input_required: ${JSON.stringify(raw)}`);
  return raw;
}

async function retry(
  client: Client,
  state: string | undefined,
  responses: Record<string, unknown>,
  text = ORIGINAL,
): Promise<CallToolResult> {
  // The 2026-07-28 retry: same name and arguments, plus inputResponses and
  // the byte-exact requestState, on a fresh request id.
  const params = {
    name: "approve_test",
    arguments: { text },
    inputResponses: responses,
    ...(state !== undefined ? { requestState: state } : {}),
  };
  return client.callTool(params, { allowInputRequired: true });
}

function texts(result: CallToolResult): string[] {
  return result.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
}

test("approve_test: first call returns input_required with one pre-filled string field and an opaque state", async () => {
  const t = await target();
  const client = await modernClient(t.url);
  try {
    const raw = await firstRound(client);
    const keys = Object.keys(raw.inputRequests ?? {});
    assert.deepEqual(keys, ["approval"]);
    const req = raw.inputRequests!["approval"]!;
    assert.equal(req.method, "elicitation/create");
    const params = req.params as {
      mode?: string;
      message: string;
      requestedSchema: { type: string; properties: Record<string, Record<string, unknown>>; required?: string[] };
    };
    assert.ok(params.mode === undefined || params.mode === "form", `mode ${params.mode}`);
    assert.equal(typeof params.message, "string");
    assert.deepEqual(Object.keys(params.requestedSchema.properties), ["question"], "exactly one field");
    assert.equal(params.requestedSchema.properties["question"]!["type"], "string");
    assert.equal(params.requestedSchema.properties["question"]!["default"], ORIGINAL, "pre-filled with the input text");
    assert.equal(typeof raw.requestState, "string");
    assert.ok(!raw.requestState!.includes(ORIGINAL), "state does not carry the question text");
  } finally {
    await client.close();
    await t.stop();
  }
});

test("approve_test: retry with accept and an edited value returns the edited value byte-identical", async () => {
  const t = await target();
  const client = await modernClient(t.url);
  try {
    const raw = await firstRound(client);
    const result = await retry(client, raw.requestState, {
      approval: { action: "accept", content: { question: EDITED } },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(texts(result)[0], EDITED);
    const meta = JSON.parse(texts(result)[1]!) as Record<string, unknown>;
    assert.equal(meta["approved"], true);
    assert.equal(meta["state_verified"], true);
  } finally {
    await client.close();
    await t.stop();
  }
});

test("approve_test: auto-fulfilling client (what a host does) sees the default and gets its edit back", async () => {
  const t = await target();
  let seenDefault: unknown;
  const client = await modernClient(t.url, (req) => {
    const params = (req as { params: { requestedSchema: { properties: Record<string, { default?: unknown }> } } }).params;
    seenDefault = params.requestedSchema.properties["question"]?.default;
    return { action: "accept", content: { question: EDITED } };
  });
  try {
    const result = await client.callTool({ name: "approve_test", arguments: { text: ORIGINAL } });
    assert.equal(seenDefault, ORIGINAL);
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(texts(result)[0], EDITED);
  } finally {
    await client.close();
    await t.stop();
  }
});

for (const action of ["decline", "cancel"] as const) {
  test(`approve_test: retry with ${action} creates nothing`, async () => {
    const t = await target();
    const client = await modernClient(t.url);
    try {
      const raw = await firstRound(client);
      const result = await retry(client, raw.requestState, { approval: { action } });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.match(texts(result)[0]!, /nothing was created/i);
      assert.ok(!texts(result).join("\n").includes(ORIGINAL), "no question text echoed on decline");
    } finally {
      await client.close();
      await t.stop();
    }
  });
}

test("approve_test: a tampered or foreign state is refused before the handler runs", async () => {
  const t = await target();
  const client = await modernClient(t.url);
  try {
    const raw = await firstRound(client);
    const state = raw.requestState!;
    const last = state.at(-1) === "A" ? "B" : "A";
    const tampered = state.slice(0, -1) + last;
    for (const bad of [tampered, "v1.e30.AAAA", "not-a-state"]) {
      await assert.rejects(
        retry(client, bad, { approval: { action: "accept", content: { question: EDITED } } }),
        (error: unknown) => {
          assert.ok(error instanceof ProtocolError, `not a ProtocolError: ${String(error)}`);
          assert.equal(error.code, -32602);
          assert.equal((error.data as { reason?: string } | undefined)?.reason, "invalid_request_state");
          return true;
        },
      );
    }
  } finally {
    await client.close();
    await t.stop();
  }
});

test("approve_test: a valid state replayed with different arguments is refused with conflict", async () => {
  const t = await target();
  const client = await modernClient(t.url);
  try {
    const raw = await firstRound(client);
    const result = await retry(
      client,
      raw.requestState,
      { approval: { action: "accept", content: { question: EDITED } } },
      "A different manifest than the one approved",
    );
    assert.equal(result.isError, true);
    assert.match(texts(result)[0]!, /conflict/);
  } finally {
    await client.close();
    await t.stop();
  }
});

test("approve_test: retry without state is refused with conflict", async () => {
  const t = await target();
  const client = await modernClient(t.url);
  try {
    const result = await retry(client, undefined, { approval: { action: "accept", content: { question: EDITED } } });
    assert.equal(result.isError, true);
    assert.match(texts(result)[0]!, /conflict/);
  } finally {
    await client.close();
    await t.stop();
  }
});

test("approve_test: state minted on one instance verifies on another", { skip: REMOTE ? "in-process only" : false }, async () => {
  const a = await start();
  const b = await start();
  let next = 0;
  const served: string[] = [];
  const roundRobin: FetchLike = async (input, init) => {
    const origin = [a.origin, b.origin][next++ % 2]!;
    const url = new URL(input.toString());
    if (typeof init?.body === "string" && init.body.includes('"tools/call"')) served.push(origin);
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  };
  const client = await modernClient(
    `${a.origin}/mcp`,
    () => ({ action: "accept", content: { question: EDITED } }),
    roundRobin,
  );
  try {
    const result = await client.callTool({ name: "approve_test", arguments: { text: ORIGINAL } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(texts(result)[0], EDITED);
    assert.equal(served.length, 2, `tools/call legs: ${served.length}`);
    assert.notEqual(served[0], served[1], "first round and retry hit different instances");
  } finally {
    await client.close();
    await a.stop();
    await b.stop();
  }
});

// Recorded behaviour, not a goal: on this stateless server a 2025-era client
// cannot be asked anything. The SDK's legacy shim needs a server-to-client
// request, which per-request serving cannot receive, so the call ends as an
// isError result and nothing is approved. This is why D1's fallback (one task,
// SDK sessions) exists if a host negotiates the 2025 revision.
test("approve_test: a 2025-era client gets an isError result, never an approval (stateless server)", { skip: REMOTE ? "in-process only" : false }, async () => {
  const s = await start();
  const client = new Client({ name: "a2h-spike-legacy", version: "0.0.0" }, { capabilities: { elicitation: { form: {} } } });
  let elicited = false;
  client.setRequestHandler("elicitation/create", () => {
    elicited = true;
    return Promise.resolve({ action: "accept" as const, content: { question: EDITED } });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.origin}/mcp`)));
  try {
    assert.equal(client.getProtocolEra(), "legacy");
    const result = await client.callTool({ name: "approve_test", arguments: { text: ORIGINAL } });
    assert.equal(elicited, false, "no dialog reaches a 2025-era client");
    assert.equal(result.isError, true);
    assert.match(texts(result)[0]!, /cannot receive server-to-client requests/);
    assert.ok(!texts(result).includes(EDITED));
  } finally {
    await client.close();
    await s.stop();
  }
});
