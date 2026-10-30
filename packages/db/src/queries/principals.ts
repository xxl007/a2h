// Principals, their policies and per-principal rate limits (m1-hosted-
// connector tasks 3.2; design D4, D5). Callers: apps/web creates the rows in
// the consent transaction (`ensurePrincipal`); apps/mcp reads them per tool
// call (`principalWithPolicy`, `bumpRateLimit`); apps/worker reads the policy
// at delivery and prunes old windows. Rows read back are parsed with the
// protocol's schemas: what leaves this module is a protocol shape.
//
// Typed over any Drizzle Postgres database, so the same queries run on
// node-postgres (mcp, worker), on the Data API driver (web, design D2) and
// inside a caller's transaction.
import {
  type Principal,
  PrincipalSchema,
  type RateLimitWindow,
  type ValidationPolicy,
  ValidationPolicySchema,
} from "@a2h/protocol";
import { eq, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { principalPolicies, principals, rateLimitWindows } from "../schema.ts";

/** Any Drizzle Postgres database or transaction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the drivers differ in their schema type parameters only
export type PrincipalsDb = PgDatabase<PgQueryResultHKT, any, any>;

/** A principal's own policy: the protocol ValidationPolicy without the platform's fee rate (stage configuration). */
export type PrincipalPolicy = Omit<ValidationPolicy, "fee_rate">;
const PrincipalPolicySchema = ValidationPolicySchema.omit({ fee_rate: true });

export interface PrincipalWithPolicy {
  principal: Principal;
  policy: PrincipalPolicy;
}

export interface PrincipalDefaults {
  /** The stage's default policy (infra/config.ts `developmentPolicy` without `fee_rate`). */
  policy: PrincipalPolicy;
  /** Default `real_name`. */
  identity_mode?: Principal["identity_mode"];
}

/** A principal and its policy, or null when either row is missing. Reads only. */
export async function principalWithPolicy(db: PrincipalsDb, principalId: string): Promise<PrincipalWithPolicy | null> {
  const [row] = await db
    .select({
      principal_id: principals.principal_id,
      identity_mode: principals.identity_mode,
      verified: principals.verified,
      currency: principalPolicies.currency,
      monthly_budget_minor: principalPolicies.monthly_budget_minor,
      per_request_cap_minor: principalPolicies.per_request_cap_minor,
      ask_first_above_minor: principalPolicies.ask_first_above_minor,
      daily_request_limit: principalPolicies.daily_request_limit,
      throttled_daily_limit: principalPolicies.throttled_daily_limit,
    })
    .from(principals)
    .innerJoin(principalPolicies, eq(principalPolicies.principal_id, principals.principal_id))
    .where(eq(principals.principal_id, principalId));
  if (!row) return null;
  return {
    principal: PrincipalSchema.parse({ principal_id: row.principal_id, identity_mode: row.identity_mode, verified: row.verified }),
    policy: PrincipalPolicySchema.parse({
      currency: row.currency,
      monthly_budget_minor: row.monthly_budget_minor,
      per_request_cap_minor: row.per_request_cap_minor,
      ask_first_above_minor: row.ask_first_above_minor,
      daily_request_limit: row.daily_request_limit,
      throttled_daily_limit: row.throttled_daily_limit,
    }),
  };
}

/**
 * Create the principal and its policy from `defaults` if they do not exist,
 * in one transaction (a savepoint inside the caller's), and return the rows
 * as stored. Idempotent: an existing principal or policy is never changed, so
 * a second consent cannot reset a policy, and two concurrent calls create one
 * of each (`ON CONFLICT DO NOTHING`).
 */
export async function ensurePrincipal(db: PrincipalsDb, principalId: string, defaults: PrincipalDefaults): Promise<PrincipalWithPolicy> {
  const policy = PrincipalPolicySchema.parse(defaults.policy);
  return db.transaction(async (tx) => {
    await tx
      .insert(principals)
      .values({ principal_id: principalId, identity_mode: defaults.identity_mode ?? "real_name", verified: false })
      .onConflictDoNothing({ target: principals.principal_id });
    await tx
      .insert(principalPolicies)
      .values({ principal_id: principalId, ...policy })
      .onConflictDoNothing({ target: principalPolicies.principal_id });
    const stored = await principalWithPolicy(tx, principalId);
    if (!stored) throw new Error("principal not readable after ensurePrincipal");
    return stored;
  });
}

/**
 * Count one tool call of a principal in a window and return the new count:
 * one statement (`INSERT … ON CONFLICT DO UPDATE SET count = count + 1
 * RETURNING count`), so concurrent callers on any instance get consecutive
 * counts. `windowStart` must be on its UTC boundary (`rateLimitWindowStart`);
 * the database refuses any other start.
 */
export async function bumpRateLimit(db: PrincipalsDb, principalId: string, kind: RateLimitWindow, windowStart: Date): Promise<number> {
  const [row] = await db
    .insert(rateLimitWindows)
    .values({ principal_id: principalId, window_kind: kind, window_start: windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitWindows.principal_id, rateLimitWindows.window_kind, rateLimitWindows.window_start],
      set: { count: sql`${rateLimitWindows.count} + 1` },
    })
    .returning({ count: rateLimitWindows.count });
  if (!row) throw new Error("rate-limit upsert returned no row");
  return row.count;
}

/** Delete the windows that started before `olderThan`; returns how many were deleted. */
export async function pruneRateLimitWindows(db: PrincipalsDb, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(rateLimitWindows)
    .where(lt(rateLimitWindows.window_start, olderThan))
    .returning({ principal_id: rateLimitWindows.principal_id });
  return deleted.length;
}
