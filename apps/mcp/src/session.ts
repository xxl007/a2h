// The A2H tools' view of one HTTP request (m1-hosted-connector design D3,
// D4, D5): who is calling (the token's subject), and, when a tool runs, that
// principal and its own policy loaded from the database, after the call was
// counted against the principal's per-minute and per-day limits. Nothing in
// here comes from the deployment's configuration but the fee rate and the
// limits themselves.
import { randomBytes } from "node:crypto";
import { bumpRateLimit, type McpDb, principalWithPolicy } from "@a2h/db";
import { type ProtocolError, rateLimitedError, rateLimitWindowStart } from "@a2h/protocol";
import { createRequestStateCodec, type RequestStateCodec } from "@modelcontextprotocol/server";
import type { Caller } from "./auth.ts";
import type { Log } from "./logging.ts";
import type { ApprovalState, ToolDeps } from "./tools/common.ts";

/** Approval state lives 15 minutes (design D1); an older state is refused. */
export const APPROVAL_TTL_SECONDS = 15 * 60;

/** Per-principal tool-call limits (stage configuration: RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_DAY). */
export interface RateLimits {
  perMinute: number;
  perDay: number;
}

/** What the A2H tools need; production builds it from infra/env.ts and src/db.ts. */
export interface A2hOptions {
  db: McpDb;
  /** The platform fee rate `f` (FEE_RATE; ADR 0002): the stage's, never the principal's. */
  feeRate: number;
  clearingShare: number;
  /** HMAC key of the approval state (32 bytes or more), the same on every instance of the stage. */
  approvalKey: Uint8Array;
  limits: RateLimits;
  /** The clock; tests pin it. */
  now?: () => Date;
  /** Randomness for request ids; tests pin it. */
  randomBytes?: (n: number) => Uint8Array;
}

export type Opened = { ok: true; deps: ToolDeps } | { ok: false; error: ProtocolError };

export interface A2hSession {
  /** Undefined only on an open (tokenless) path, where no A2H tool can run. */
  caller: Caller | undefined;
  codec: RequestStateCodec<ApprovalState>;
  /** Load the principal, count the call, build the tool's dependencies; or the refusal. Writes nothing else. */
  open: () => Promise<Opened>;
  log: Log;
}

const NO_PRINCIPAL: ProtocolError = {
  code: "unauthorized",
  stage: "principal",
  retryable: false,
  detail: "This account is not set up as a principal yet. Sign in again to authorize this client; nothing was done.",
};

/** Bound to no account: a state can never verify for a tokenless caller. */
const NOBODY = "\u0000no-principal";

export function a2hSession(stage: string, o: A2hOptions, caller: Caller | undefined, log: Log): A2hSession {
  const now = o.now ?? (() => new Date());
  const random = o.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const principalId = caller?.principal_id;
  // HMAC-signed (not encrypted) state, bound to the principal of the
  // connection: a state minted for one account fails for another.
  const codec = createRequestStateCodec<ApprovalState>({ key: o.approvalKey, ttlSeconds: APPROVAL_TTL_SECONDS, bind: () => principalId ?? NOBODY });
  return {
    caller,
    codec,
    log,
    async open() {
      if (principalId === undefined) return { ok: false, error: NO_PRINCIPAL };
      // The web app creates the rows on consent (D4); this side only reads them.
      const found = await principalWithPolicy(o.db, principalId);
      if (!found) return { ok: false, error: NO_PRINCIPAL };
      const at = now();
      const minute = await bumpRateLimit(o.db, principalId, "minute", rateLimitWindowStart("minute", at));
      const day = await bumpRateLimit(o.db, principalId, "day", rateLimitWindowStart("day", at));
      if (minute > o.limits.perMinute) return { ok: false, error: rateLimitedError("minute", at) };
      if (day > o.limits.perDay) return { ok: false, error: rateLimitedError("day", at) };
      return {
        ok: true,
        deps: {
          stage,
          db: o.db,
          principal: found.principal,
          policy: { ...found.policy, fee_rate: o.feeRate },
          clearingShare: o.clearingShare,
          codec,
          now,
          randomBytes: random,
          log,
        },
      };
    },
  };
}

/** At most `max` held pings at once on this instance (spec hosted-endpoint "Held connections are capped"). */
export class HeldPings {
  #active = 0;
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get active(): number {
    return this.#active;
  }
  tryAcquire(): boolean {
    if (this.#active >= this.max) return false;
    this.#active++;
    return true;
  }
  release(): void {
    this.#active = Math.max(0, this.#active - 1);
  }
}
