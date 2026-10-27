// Scenario "Idle stream survives" (mcp-transport spec): a response that
// sends nothing for 61 minutes is still open from the client's point of view.
// Opt-in: skipped unless A2H_IDLE_MINUTES is set. Run once per infra change:
//   A2H_MCP_URL=http://<alb>/pr-<n>/mcp A2H_IDLE_MINUTES=61 pnpm --filter @a2h/tests contract
// The client side has no timeout of its own (undici agent with headers and
// body timeouts off, SDK request timeout above the hold), so a failure here
// is the infrastructure (ALB idle timeout, task replaced) or the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedStage, mcpUrl } from "../src/live-env.ts";
import { connectFresh } from "./mcp-client.ts";

const raw = process.env.A2H_IDLE_MINUTES?.trim();
const minutes = raw ? Number(raw) : undefined;
if (minutes !== undefined && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 65)) {
  throw new Error(`A2H_IDLE_MINUTES must be an integer 1..65 (holdSeconds <= 3900), got "${raw}"`);
}
const holdSeconds = (minutes ?? 0) * 60;
const MARGIN_MS = 120_000;

test(
  `Scenario: Idle stream survives (${minutes ?? "-"} min)`,
  {
    skip: minutes === undefined ? "set A2H_IDLE_MINUTES=61 to run (takes that long)" : false,
    timeout: holdSeconds * 1_000 + 2 * MARGIN_MS,
  },
  async () => {
    const url = mcpUrl();
    const stage = expectedStage(url);
    const { client, close } = await connectFresh({ patient: true });
    try {
      const started = Date.now();
      const result = await client.callTool(
        { name: "ping", arguments: { holdSeconds } },
        { timeout: holdSeconds * 1_000 + MARGIN_MS },
      );
      const waitedSeconds = Math.round((Date.now() - started) / 1_000);
      assert.ok(waitedSeconds >= holdSeconds, `pong came after ${waitedSeconds} s, before the ${holdSeconds} s hold`);
      assert.ok(!result.isError, `result is marked isError: ${JSON.stringify(result)}`);
      const first = result.content[0];
      assert.ok(first && first.type === "text" && first.text.startsWith("pong"), JSON.stringify(result.content));
      assert.ok(first.text.includes(stage), `pong does not name stage "${stage}": ${first.text}`);
      console.log(`idle stream: pong after ${waitedSeconds} s on ${url.href}`);
    } finally {
      await close();
    }
  },
);
