// Per-principal tool-call limits (m1-hosted-connector design D5; spec
// hosted-endpoint "Per-principal tool-call limit"). The limits themselves are
// stage configuration; the windows they count in are a closed set.
import * as z from "zod";

/** The windows a principal's tool calls are counted in: a UTC minute and a UTC day. */
export const RATE_LIMIT_WINDOWS = ["minute", "day"] as const;
export const RateLimitWindowSchema = z.enum(RATE_LIMIT_WINDOWS);
export type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

const WINDOW_MS: Record<RateLimitWindow, number> = { minute: 60_000, day: 86_400_000 };

/**
 * The start of the window `at` falls in, on its UTC boundary. Every instance
 * computes the same start for the same moment, so their counts meet in one
 * row (spec hosted-endpoint "Limit shared across instances"). The time is an
 * argument: this package reads no clock.
 */
export function rateLimitWindowStart(kind: RateLimitWindow, at: Date): Date {
  const ms = WINDOW_MS[kind];
  return new Date(Math.floor(at.getTime() / ms) * ms);
}
