// The manifest and the validation facts of a stored request, loaded from the
// database at delivery time (design D6: the pipeline is pure, the caller
// loads the facts). Delivery re-checks the participant's rules only: budget
// and throttle were counted at approval (`phase: "delivery"`).
import { and, count, eq, gte } from "drizzle-orm";
import type { Manifest, Principal, RulesOfEngagement, ValidationFacts, ValidationPolicy } from "@a2h/protocol";
import { participants, principalWithPolicy, requestDeliveries, rules, ruleTypes } from "@a2h/db";
import type { WorkerConfig } from "./config.ts";
import type { Db } from "./db.ts";
import type { RequestRow } from "./lifecycle.ts";

export type ParticipantRow = typeof participants.$inferSelect;

export function manifestOf(r: RequestRow, handle: string): Manifest {
  const m: Record<string, unknown> = {
    to: handle,
    intent: r.intent,
    audience: r.audience,
    time_shape: r.time_shape,
    format: r.format,
    question: r.question,
    lane: r.lane,
    bid_minor: r.bid_minor,
    currency: r.currency,
    expires_at: r.expires_at.toISOString(),
    data_terms: r.data_terms,
    principal_id: r.principal_id,
  };
  if (r.free_lane !== null) m["free_lane"] = r.free_lane;
  if (r.options !== null) m["options"] = r.options;
  if (r.scale !== null) m["scale"] = r.scale;
  if (r.attachments !== null) m["attachments"] = r.attachments;
  // Checked by validateManifest's schema stage, like any manifest.
  return m as Manifest;
}

/** Rules that accept nothing: what a participant without published rules has. */
const NO_RULES: RulesOfEngagement = {
  types: [],
  free_lanes: [],
  who_may_ask: "organisations_only",
  quiet_hours: null,
  max_interruptions_per_day: 0,
  latency_promise_seconds: 0,
};

/** The participant's rules as published now; without any, rules that accept nothing (fails closed). */
export async function currentRules(db: Db, participantId: string): Promise<RulesOfEngagement> {
  const [r] = await db.select().from(rules).where(eq(rules.participant_id, participantId));
  if (!r) return NO_RULES;
  const types = await db.select().from(ruleTypes).where(eq(ruleTypes.participant_id, participantId));
  return {
    types: types.map((t) => ({ intent: t.intent, accepted: t.accepted, reserve_net_minor: t.reserve_net_minor, currency: t.currency })),
    free_lanes: r.free_lanes,
    who_may_ask: r.who_may_ask,
    quiet_hours: r.quiet_start && r.quiet_end && r.quiet_time_zone ? { start: r.quiet_start, end: r.quiet_end, time_zone: r.quiet_time_zone } : null,
    max_interruptions_per_day: r.max_interruptions_per_day,
    latency_promise_seconds: r.latency_promise_seconds,
  } as RulesOfEngagement;
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
