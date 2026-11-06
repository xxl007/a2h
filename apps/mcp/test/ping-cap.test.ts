// m1-hosted-connector task 7.3 (design D5): held pings are capped per
// instance by PING_MAX_CONCURRENT. Spec platform/hosted-endpoint "Held
// connections are capped", scenario "Cap reached".
//
// Deterministic by state, not by the clock. CI run 41701527252 (attempt 1)
// failed with "refused at once, not queued (2377 ms)": a fixed 300 ms wait was
// not enough for both held calls to reach the server on a loaded runner, so
// the extra ping found a free slot and was held for its 2 s. The test now
// waits for the instance's held count, and reads "refused at once, not queued"
// off the same count: the refusal comes back while both holds are still active
// and neither has returned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, start } from "./helpers.ts";

/** Resolves once `condition` holds; fails after `timeoutMs` (never a fixed sleep). */
async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("Scenario: Cap reached: the extra held ping is refused at once with rate_limited; the held ones continue", async () => {
  const s = await start({ pingMaxConcurrent: 2 });
  const clients = await Promise.all([0, 1, 2, 3].map(() => connect(`${s.origin}/mcp`)));
  try {
    const returned = [false, false];
    const held = [clients[0]!, clients[1]!].map((c, i) =>
      c.callTool({ name: "ping", arguments: { holdSeconds: 3 } }).finally(() => {
        returned[i] = true;
      }),
    );
    // Both holds have reached the server and taken the two slots.
    await until(() => s.app.heldPings.active === 2, "both held pings to start");
    const extra = await clients[2]!.callTool({ name: "ping", arguments: { holdSeconds: 3 } });
    // Refused at once, not queued: the answer came back while both holds were still running.
    assert.equal(s.app.heldPings.active, 2, "the held ones continue");
    assert.deepEqual(returned, [false, false], "the refusal did not wait for a hold to end");
    assert.equal(extra.isError, true);
    const error = (extra.structuredContent as { error: { code: string; retryable: boolean } }).error;
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryable, true);
    // A ping that holds nothing is not a held connection and is never refused.
    const instant = await clients[3]!.callTool({ name: "ping" });
    assert.deepEqual(instant.content, [{ type: "text", text: "pong from stage test" }]);
    for (const r of await Promise.all(held)) assert.deepEqual(r.content, [{ type: "text", text: "pong from stage test" }]);
    // The slots are back once they ended, and a held ping is accepted again.
    assert.equal(s.app.heldPings.active, 0);
    const again = await clients[2]!.callTool({ name: "ping", arguments: { holdSeconds: 1 } });
    assert.equal(again.isError, undefined);
  } finally {
    for (const c of clients) await c.close();
    await s.stop();
  }
});
