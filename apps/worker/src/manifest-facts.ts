// The manifest and the validation facts of a stored request, loaded from the
// database at delivery time (design D6: the pipeline is pure, the caller
// loads the facts). Delivery re-checks the participant's rules only: budget
// and throttle were counted at approval (`phase: "delivery"`).
import { and, count, eq, gte } from "drizzle-orm";
import type { Manifest, Principal, RulesOfEngagement, ValidationFacts, ValidationPolicy } from "@a2h/protocol";
import { currentRules as sharedCurrentRules, manifestOfRequest, participants, principalWithPolicy, requestDeliveries } from "@a2h/db";
import type { WorkerConfig } from "./config.ts";
import type { Db } from "./db.ts";
import type { RequestRow } from "./lifecycle.ts";

export type ParticipantRow = typeof participants.$inferSelect;

/** The stored request's manifest: the shared reader of packages/db (the approval page uses the same). */
export function manifestOf(r: RequestRow, handle: string): Manifest {
  return manifestOfRequest(r, handle);
}

/** The participant's rules as published now (shared with the approval page); without any, rules that accept nothing. */
export function currentRules(db: Db, participantId: string): Promise<RulesOfEngagement> {
  return sharedCurrentRules(db, participantId);
}

/** Start of the UTC day of `now`: the interruption budget counts deliveries since then. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Requests actually delivered to the participant since the start of today (UTC). */
export async function deliveriesToday(db: Db, participantId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(requestDeliveries)
    .where(and(eq(requestDeliveries.participant_id, participantId), eq(requestDeliveries.outcome, "delivered"), gte(requestDeliveries.at, utcDayStart(now))));
  return row?.n ?? 0;
}

/**
 * The request's principal and its own policy as recorded now (m1-hosted-
 * connector design D4: rows, not the deployment's configuration), with the
 * stage's fee rate; null when the rows are gone, and delivery then fails closed.
 */
export async function principalOf(db: Db, config: WorkerConfig, principalId: string): Promise<{ principal: Principal; policy: ValidationPolicy } | null> {
  const found = await principalWithPolicy(db, principalId);
  return found ? { principal: found.principal, policy: { ...found.policy, fee_rate: config.feeRate } } : null;
}

export function deliveryFacts(principal: Principal, policy: ValidationPolicy, participant: ParticipantRow, participantRules: RulesOfEngagement, interruptionsToday: number, now: Date): ValidationFacts {
  return {
    now: now.toISOString(),
    principal,
    participant: { participant_id: participant.id, handle: participant.handle, rules: participantRules },
    interruptions_today: interruptionsToday,
    // Skipped in the delivery phase (counted at approval); present because the facts shape requires them.
    budget: { used_minor: 0, currency: policy.currency },
    requests_today: 0,
    principal_throttled: false,
    approval: "recorded",
  };
}
