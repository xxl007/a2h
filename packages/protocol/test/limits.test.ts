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

// m1-hosted-connector task 7.3: a call over the limit fails with `rate_limited`
// and says when to retry (spec hosted-endpoint "Minute limit reached").
test("retry after: the seconds left in the window, rounded up, at least one", async () => {
  const { retryAfterSeconds } = await import("../src/index.ts");
  assert.equal(retryAfterSeconds("minute", new Date("2026-10-27T10:15:42.000Z")), 18);
  assert.equal(retryAfterSeconds("minute", new Date("2026-10-27T10:15:42.200Z")), 18);
  assert.equal(retryAfterSeconds("minute", new Date("2026-10-27T10:15:00.000Z")), 60);
  assert.equal(retryAfterSeconds("minute", new Date("2026-10-27T10:15:59.999Z")), 1);
  assert.equal(retryAfterSeconds("day", new Date("2026-10-27T23:00:00.000Z")), 3600);
});

test("rate_limited error: a retryable throttle-stage ProtocolError with retry_after_seconds in details", async () => {
  const { rateLimitedError, ProtocolErrorSchema } = await import("../src/index.ts");
  const e = rateLimitedError("minute", new Date("2026-10-27T10:15:42.000Z"));
  assert.deepEqual(ProtocolErrorSchema.parse(e), e);
  assert.equal(e.code, "rate_limited");
  assert.equal(e.stage, "throttle");
  assert.equal(e.retryable, true);
  assert.deepEqual(e.details, { retry_after_seconds: 18 });
  assert.match(e.detail ?? "", /per-minute/);
  assert.match(rateLimitedError("day", new Date("2026-10-27T23:00:00.000Z")).detail ?? "", /per-day/);
});

test("unauthorized is a ProtocolError code (m1-hosted-connector: a token whose account has no principal yet)", async () => {
  const { ProtocolErrorCodeSchema } = await import("../src/index.ts");
  assert.equal(ProtocolErrorCodeSchema.parse("unauthorized"), "unauthorized");
});
