// m1-hosted-connector task 7.3 (design D5): held pings are capped per
// instance by PING_MAX_CONCURRENT. Spec platform/hosted-endpoint "Held
// connections are capped", scenario "Cap reached".
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, start } from "./helpers.ts";

test("Scenario: Cap reached: the extra held ping is refused at once with rate_limited; the held ones continue", async () => {
  const s = await start({ pingMaxConcurrent: 2 });
  const clients = await Promise.all([0, 1, 2, 3].map(() => connect(`${s.origin}/mcp`)));
  try {
    const held = [clients[0]!, clients[1]!].map((c) => c.callTool({ name: "ping", arguments: { holdSeconds: 2 } }));
    // Let both holds start.
    await new Promise((r) => setTimeout(r, 300));
    const started = performance.now();
    const extra = (await clients[2]!.callTool({ name: "ping", arguments: { holdSeconds: 2 } }));
    const waited = performance.now() - started;
    assert.ok(waited < 1000, `refused at once, not queued (${Math.round(waited)} ms)`);
    assert.equal(extra.isError, true);
    const error = (extra.structuredContent as { error: { code: string; retryable: boolean } }).error;
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryable, true);
    // A ping that holds nothing is not a held connection and is never refused.
    const instant = (await clients[3]!.callTool({ name: "ping" }));
    assert.deepEqual(instant.content, [{ type: "text", text: "pong from stage test" }]);
    for (const r of await Promise.all(held)) assert.deepEqual(r.content, [{ type: "text", text: "pong from stage test" }]);
    // Once they ended, a held ping is accepted again.
    const again = (await clients[2]!.callTool({ name: "ping", arguments: { holdSeconds: 1 } }));
    assert.equal(again.isError, undefined);
  } finally {
    for (const c of clients) await c.close();
    await s.stop();
  }
});
