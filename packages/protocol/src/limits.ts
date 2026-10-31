// Per-principal tool-call limits (m1-hosted-connector design D5; spec
// hosted-endpoint "Per-principal tool-call limit"). The limits themselves are
// stage configuration; the windows they count in are a closed set.
import * as z from "zod";
import type { ProtocolError } from "./errors.ts";

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

/**
 * Whole seconds from `at` to the end of its window, rounded up, at least one:
 * the `Retry-After` of a call refused in that window.
 */
export function retryAfterSeconds(kind: RateLimitWindow, at: Date): number {
  const end = rateLimitWindowStart(kind, at).getTime() + WINDOW_MS[kind];
  return Math.max(1, Math.ceil((end - at.getTime()) / 1000));
}

const LIMIT_TEXT: Record<RateLimitWindow, string> = {
  minute: "Over the per-minute limit of tool calls for this principal. Nothing was done; retry later.",
  day: "Over the per-day limit of tool calls for this principal. Nothing was done; retry later.",
};

/** The refusal of a call over a principal's limit in `kind` (spec hosted-endpoint "Minute limit reached"). */
export function rateLimitedError(kind: RateLimitWindow, at: Date): ProtocolError {
  return {
    code: "rate_limited",
    stage: "throttle",
    retryable: true,
    detail: LIMIT_TEXT[kind],
    details: { retry_after_seconds: retryAfterSeconds(kind, at) },
  };
}
