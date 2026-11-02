// Renders the simulated set as SQL statements for db-migrate.sh (design D8).
// Upserts by handle, so applying twice leaves one copy (spec "Redeploy").
// Statements are separated by drizzle-kit's breakpoint marker, as in
// migrations/, and run in one transaction. The first statement refuses to
// run unless the transaction set `a2h.stage` to a non-production stage: the
// script skips the seed on prod, and the SQL refuses it on its own as well.
import { SEED_DEV_BUDGET_MULTIPLIER, SEED_PARTICIPANTS, SEED_PERSONAS, SEED_PRINCIPAL, SEED_PRINCIPAL_POLICY, type SeedParticipant } from "./simulated.ts";

export const SEED_SQL_PATH = new URL("./seed.sql", import.meta.url).pathname;
const BREAK = "\n--> statement-breakpoint\n";

/** A SQL literal; seed values are constants in this repository, quoted all the same. */
function q(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("non-finite number in seed");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${value.replaceAll("'", "''")}'`;
}

function participantStatements(p: SeedParticipant): string[] {
  const pid = q(p.id);
  const r = p.rules;
  const qh = r.quiet_hours;
  const out = [
    `INSERT INTO participants (id, handle, display_label, simulated, persona, identity_verified)
VALUES (${pid}, ${q(p.handle)}, ${q(p.display_label)}, true, ${q(p.persona)}, ${q(p.identity_verified)})
ON CONFLICT (handle) DO UPDATE SET display_label = EXCLUDED.display_label, simulated = true,
  persona = EXCLUDED.persona, identity_verified = EXCLUDED.identity_verified`,
    `INSERT INTO profiles (participant_id, topics, rating, answers_count, disputes_lost, typical_latency_seconds)
SELECT id, ${q(JSON.stringify(p.topics))}::jsonb, ${q(p.rating.rating)}, ${q(p.rating.answers)}, ${q(p.rating.disputes_lost)}, ${q(p.rating.typical_latency_seconds)}
FROM participants WHERE handle = ${q(p.handle)}
ON CONFLICT (participant_id) DO UPDATE SET topics = EXCLUDED.topics, rating = EXCLUDED.rating,
  answers_count = EXCLUDED.answers_count, disputes_lost = EXCLUDED.disputes_lost,
  typical_latency_seconds = EXCLUDED.typical_latency_seconds, updated_at = now()`,
    `INSERT INTO rules (participant_id, who_may_ask, free_lanes, quiet_start, quiet_end, quiet_time_zone, max_interruptions_per_day, latency_promise_seconds)
SELECT id, ${q(r.who_may_ask)}, ARRAY[${r.free_lanes.map(q).join(", ")}]::varchar[], ${q(qh?.start ?? null)}, ${q(qh?.end ?? null)}, ${q(qh?.time_zone ?? null)}, ${q(r.max_interruptions_per_day)}, ${q(r.latency_promise_seconds)}
FROM participants WHERE handle = ${q(p.handle)}
ON CONFLICT (participant_id) DO UPDATE SET who_may_ask = EXCLUDED.who_may_ask, free_lanes = EXCLUDED.free_lanes,
  quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end, quiet_time_zone = EXCLUDED.quiet_time_zone,
  max_interruptions_per_day = EXCLUDED.max_interruptions_per_day, latency_promise_seconds = EXCLUDED.latency_promise_seconds, updated_at = now()`,
    `DELETE FROM rule_types WHERE participant_id = (SELECT id FROM participants WHERE handle = ${q(p.handle)})
  AND intent NOT IN (${r.types.map((t) => q(t.intent)).join(", ")})`,
  ];
  for (const t of r.types) {
    out.push(`INSERT INTO rule_types (participant_id, intent, accepted, reserve_net_minor, currency)
SELECT id, ${q(t.intent)}, ${q(t.accepted)}, ${q(t.reserve_net_minor)}, ${q(t.currency)}
FROM participants WHERE handle = ${q(p.handle)}
ON CONFLICT (participant_id, intent) DO UPDATE SET accepted = EXCLUDED.accepted,
  reserve_net_minor = EXCLUDED.reserve_net_minor, currency = EXCLUDED.currency`);
  }
  return out;
}

export function seedSql(): string {
  const guard = `DO $$
BEGIN
  IF coalesce(current_setting('a2h.stage', true), '') IN ('', 'prod') THEN
    RAISE EXCEPTION 'simulated participants are never seeded on prod, nor without a2h.stage set (got "%")', coalesce(current_setting('a2h.stage', true), '');
  END IF;
END
$$`;
  const personas = SEED_PERSONAS.map(
    (p) => `INSERT INTO simulated_personas (persona, delay_seconds, decline_reason_code)
VALUES (${q(p.persona)}, ${q(p.delay_seconds)}, ${q(p.decline_reason_code)})
ON CONFLICT (persona) DO UPDATE SET delay_seconds = EXCLUDED.delay_seconds, decline_reason_code = EXCLUDED.decline_reason_code`,
  );
  // The stage's fallback principal, created once and never overwritten (a re-seed keeps an edited policy).
  const id = `'dev-principal-' || current_setting('a2h.stage')`;
  const p = SEED_PRINCIPAL_POLICY;
  const budget = `CASE WHEN current_setting('a2h.stage') = 'dev' THEN ${q(p.monthly_budget_minor * SEED_DEV_BUDGET_MULTIPLIER)} ELSE ${q(p.monthly_budget_minor)} END`;
  const principal = [
    `INSERT INTO principals (principal_id, identity_mode, verified)
VALUES (${id}, ${q(SEED_PRINCIPAL.identity_mode)}, ${q(SEED_PRINCIPAL.verified)})
ON CONFLICT (principal_id) DO NOTHING`,
    `INSERT INTO principal_policies (principal_id, currency, monthly_budget_minor, per_request_cap_minor, ask_first_above_minor, daily_request_limit, throttled_daily_limit)
VALUES (${id}, ${q(p.currency)}, ${budget}, ${q(p.per_request_cap_minor)}, ${q(p.ask_first_above_minor)}, ${q(p.daily_request_limit)}, ${q(p.throttled_daily_limit)})
ON CONFLICT (principal_id) DO NOTHING`,
  ];
  const header = "-- Generated by packages/db/seed/sql.ts from seed/simulated.ts (pnpm --filter @a2h/db seed:sql). Do not edit.\n";
  return header + [guard, ...personas, ...SEED_PARTICIPANTS.flatMap(participantStatements), ...principal].join(BREAK) + "\n";
}
