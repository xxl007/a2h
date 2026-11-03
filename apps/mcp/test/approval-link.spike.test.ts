// THROWAWAY SPIKE ONLY, never merged. openspec/changes/m2-approval-page
// tasks.md 1.1 (design D3): `approval_link_spike` answers a client that
// declares `elicitation.url` with a 2026-07-28 `input_required` URL-mode
// elicitation pointing at a static page on the stage's web host, and logs per
// call the protocol version, the declared elicitation modes and the outcome.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { callRaw, isInputRequired, legacyClient, retry, texts } from "./lib/a2h.ts";
import { NO_AUTH, start, type Running } from "./helpers.ts";

const WEB = "https://pr-0.dev.a2h.test";

async function modern(url: string, elicitation: { form?: Record<string, never>; url?: Record<string, never> } | undefined): Promise<Client> {
  const client = new Client(
    { name: "a2h-spike", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: elicitation ? { elicitation } : {},
      inputRequired: { autoFulfill: false },
    },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe("approval_link_spike (throwaway)", () => {
  let s: Running;
  before(async () => {
    s = await start({ auth: { ...NO_AUTH, issuer: `${WEB}/api/auth` } });
  });
  after(async () => s.stop());

  const spikeLines = () => s.logs.filter((l) => l["msg"] === "url elicitation spike");

  test("client with elicitation.url: input_required URL elicitation to the web host, accept completes", async () => {
    const client = await modern(`${s.origin}/mcp`, { form: {}, url: {} });
    try {
      const raw = await callRaw(client, "approval_link_spike", {});
      assert.ok(isInputRequired(raw), JSON.stringify(raw));
      const req = Object.values(raw.inputRequests ?? {})[0] as unknown as { method: string; params: Record<string, unknown> };
      assert.equal(req.method, "elicitation/create");
      assert.equal(req.params["mode"], "url");
      assert.ok(String(req.params["url"]).startsWith(`${WEB}/`), String(req.params["url"]));
      assert.equal(typeof req.params["message"], "string");
      assert.ok(raw.requestState, "correlation travels in requestState (no elicitationId on 2026-07-28)");
      const key = Object.keys(raw.inputRequests ?? {})[0]!;
      const done = await retry(client, "approval_link_spike", {}, raw.requestState, { [key]: { action: "accept" } });
      assert.ok(!done.isError, texts(done).join(" | "));
      assert.match(texts(done).join("\n"), /accept/);
      const [first, second] = spikeLines().slice(-2);
      assert.deepEqual(
        { v: first!["protocol_version"], f: first!["elicitation_form"], u: first!["elicitation_url"], o: first!["outcome"], r: first!["round"] },
        { v: "2026-07-28", f: true, u: true, o: "input_required", r: "first" },
      );
      assert.equal(second!["round"], "retry");
      assert.equal(second!["outcome"], "accept");
    } finally {
      await client.close();
    }
  });

  for (const action of ["decline", "cancel"] as const) {
    test(`client with elicitation.url: ${action} is logged`, async () => {
      const client = await modern(`${s.origin}/mcp`, { url: {} });
      try {
        const raw = await callRaw(client, "approval_link_spike", {});
        assert.ok(isInputRequired(raw));
        const key = Object.keys(raw.inputRequests ?? {})[0]!;
        const done = await retry(client, "approval_link_spike", {}, raw.requestState, { [key]: { action } });
        assert.match(texts(done).join("\n"), new RegExp(action));
        assert.equal(spikeLines().at(-1)!["outcome"], action);
      } finally {
        await client.close();
      }
    });
  }

  test("client without elicitation.url: the link is in the text, outcome none", async () => {
    const client = await modern(`${s.origin}/mcp`, { form: {} });
    try {
      const raw = await callRaw(client, "approval_link_spike", {});
      assert.ok(!isInputRequired(raw));
      assert.match(texts(raw).join("\n"), new RegExp(`${WEB}/`));
      const line = spikeLines().at(-1)!;
      assert.equal(line["elicitation_url"], false);
      assert.equal(line["outcome"], "none");
    } finally {
      await client.close();
    }
  });

  test("2025-era client: the link is in the text, version logged", async () => {
    const client = await legacyClient(`${s.origin}/mcp`);
    try {
      const raw = await client.callTool({ name: "approval_link_spike", arguments: {} });
      assert.match(texts(raw).join("\n"), new RegExp(`${WEB}/`));
      const line = spikeLines().at(-1)!;
      assert.equal(line["outcome"], "none");
      assert.notEqual(line["protocol_version"], "2026-07-28");
    } finally {
      await client.close();
    }
  });

  test("no body, no PII in the spike lines: only scalar ids, flags and outcomes", () => {
    const allowed = new Set(["level", "msg", "tool", "round", "protocol_version", "elicitation_form", "elicitation_url", "elicitation_declared", "outcome", "principal_id", "client_id", "http_request_id", "spike_id", "client_name", "client_version"]);
    for (const line of spikeLines()) for (const k of Object.keys(line)) assert.ok(allowed.has(k), `unexpected field ${k}`);
  });
});
