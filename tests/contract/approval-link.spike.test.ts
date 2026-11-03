// THROWAWAY SPIKE ONLY, never merged. openspec/changes/m2-approval-page
// tasks.md 1.1: the preview's `approval_link_spike` over the real edge, with
// the verify job's token. A 2026-07-28 client that declares URL elicitation
// gets a well-formed `input_required` URL elicitation pointing at the
// preview's own web host, and the retry completes for accept, decline and
// cancel. Without A2H_TOKEN (a local run) the file is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { bearerToken, mcpUrl, webUrl } from "../src/live-env.ts";
import { PROTOCOL_VERSION, recordingFetch } from "./mcp-client.ts";

const noToken = bearerToken() ? false : "no A2H_TOKEN (the verify job provides one)";

interface Round {
  resultType?: string;
  inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
  requestState?: string;
}

async function urlClient(): Promise<Client> {
  const { fetch } = recordingFetch();
  const client = new Client(
    { name: "a2h-contract-url-spike", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } }, capabilities: { elicitation: { form: {}, url: {} } }, inputRequired: { autoFulfill: false } },
  );
  await client.connect(new StreamableHTTPClientTransport(mcpUrl(), { fetch }), { timeout: 30_000 });
  return client;
}

function text(r: CallToolResult): string {
  return r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
}

for (const action of ["accept", "decline", "cancel"] as const) {
  test(`spike: URL elicitation on the preview, retry with ${action}`, { skip: noToken }, async () => {
    const web = await webUrl();
    const client = await urlClient();
    try {
      const raw = (await client.callTool({ name: "approval_link_spike", arguments: {} }, { allowInputRequired: true, timeout: 30_000 })) as Round;
      assert.equal(raw.resultType, "input_required", JSON.stringify(raw).slice(0, 400));
      const entries = Object.entries(raw.inputRequests ?? {});
      assert.equal(entries.length, 1);
      const [key, req] = entries[0]!;
      assert.equal(req.method, "elicitation/create");
      assert.equal(req.params["mode"], "url");
      const url = new URL(String(req.params["url"]));
      assert.equal(url.protocol, "https:");
      assert.equal(url.origin, new URL(web).origin, `the link is on the preview's web host (${web})`);
      assert.ok(String(req.params["message"]).length > 0);
      assert.equal(typeof raw.requestState, "string");
      // The page itself answers (a static page on the web host).
      const page = await fetch(url, { redirect: "manual" });
      assert.ok(page.status < 500, `web host answered ${page.status}`);
      const done = await client.callTool(
        { name: "approval_link_spike", arguments: {}, inputResponses: { [key]: { action } }, requestState: raw.requestState } as never,
        { allowInputRequired: true, timeout: 30_000 },
      );
      assert.match(text(done), new RegExp(`"${action}"`));
      console.log(`spike ${action}: url ${url.origin}${url.pathname}, page ${page.status}, retry ok`);
    } finally {
      await client.close();
    }
  });
}
