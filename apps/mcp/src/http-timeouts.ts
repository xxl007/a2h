// Node HTTP server timeouts. Pure constants, no imports.
//
// Spec mcp-transport, scenario "Idle stream survives": a response may stay
// open with nothing sent either way for 61 minutes (3660 s). The ALB in front
// allows 4000 s idle (infra/config.ts ALB_IDLE_TIMEOUT_SECONDS, the AWS
// maximum). Node must not be the one to cut it:
//
// - requestTimeout = 0: Node's default (300 s) bounds the whole request and
//   would kill a held `ping` (or any long call) after five minutes.
// - keepAliveTimeout above the ALB idle timeout: the ALB reuses idle
//   connections to targets; if Node closed one first, the ALB could send a
//   request on a socket Node is closing and answer 502. Keeping Node's idle
//   timeout longer than the ALB's lets the ALB close first.
// - headersTimeout must be greater than keepAliveTimeout (Node's own rule,
//   otherwise a reused connection can hit the headers timeout first).

/** 4010 s: just above the ALB idle timeout of 4000 s. */
export const KEEP_ALIVE_TIMEOUT_MS = 4_010_000;

/** Above KEEP_ALIVE_TIMEOUT_MS, as Node requires. */
export const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 5_000;

/** Disabled: no bound on a whole request's lifetime. */
export const REQUEST_TIMEOUT_MS = 0;
