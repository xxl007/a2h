// m1-hosted-connector design D5: the windows a per-principal tool-call limit
// counts in (spec hosted-endpoint "Per-principal tool-call limit"). The
// database's rate_limit_windows.window_kind takes its values from here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMIT_WINDOWS, RateLimitWindowSchema } from "../src/index.ts";

test("the per-principal limit counts per minute and per day, nothing else", () => {
  assert.deepEqual([...RATE_LIMIT_WINDOWS], ["minute", "day"]);
  assert.equal(RateLimitWindowSchema.parse("minute"), "minute");
  assert.equal(RateLimitWindowSchema.safeParse("hour").success, false);
});

test("a window starts on its UTC boundary, whatever the instance's clock offset within it", async () => {
  const { rateLimitWindowStart } = await import("../src/index.ts");
  const at = new Date("2026-10-27T23:59:59.999Z");
  assert.equal(rateLimitWindowStart("minute", at).toISOString(), "2026-10-27T23:59:00.000Z");
  assert.equal(rateLimitWindowStart("day", at).toISOString(), "2026-10-27T00:00:00.000Z");
  assert.equal(rateLimitWindowStart("minute", new Date("2026-10-27T10:15:00.000Z")).toISOString(), "2026-10-27T10:15:00.000Z");
});
