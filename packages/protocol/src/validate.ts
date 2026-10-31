// The manifest validation pipeline (protocol skill §5; spec
// protocol/request-approval; design D6). Pure: every fact is loaded by the
// caller (apps/mcp at approval, apps/worker at delivery) and passed in, the
// clock included. Ordered: schema → principal → content → rules → budget →
// throttle; the first failure is returned.
import * as z from "zod";
import { classifyForbiddenContent, type ForbiddenContentClass } from "./content-rules.ts";
import type { BlockedManifest, ParticipantBlockCode, ProtocolError, ProtocolErrorCode, ProtocolStage } from "./errors.ts";
import { type Manifest, ManifestSchema, PrincipalSchema } from "./manifest.ts";
import { gross } from "./money.ts";
import { CurrencySchema, DatetimeSchema, HandleSchema, MinorAmountSchema, OpaqueIdSchema } from "./primitives.ts";
import { type QuietHours, RulesOfEngagementSchema } from "./profile.ts";

/** The principal's contact policy and the platform's fee rate (design D7; ADR 0002: f is configuration). */
export const ValidationPolicySchema = z.strictObject({
  fee_rate: z.number().min(0).lt(1),
  currency: CurrencySchema,
  monthly_budget_minor: MinorAmountSchema,
  per_request_cap_minor: MinorAmountSchema,
  /** Bids above this need a recorded approval; null: every request does. */
  ask_first_above_minor: MinorAmountSchema.nullable(),
  daily_request_limit: z.int().min(0),
  /** The lower daily limit of a principal with a low internal rating (throttled before blocked). */
  throttled_daily_limit: z.int().min(0),
});
export type ValidationPolicy = z.infer<typeof ValidationPolicySchema>;

/** Everything the pipeline needs to know about the world, loaded by the caller. */
export const ValidationFactsSchema = z.strictObject({
  /** Delivery time being evaluated: the request time at approval, the job time at delivery. */
  now: DatetimeSchema,
  principal: PrincipalSchema,
  participant: z.strictObject({ participant_id: OpaqueIdSchema, handle: HandleSchema, rules: RulesOfEngagementSchema }),
  /** Deliveries to this participant counted for the current day, deferred ones included. */
  interruptions_today: z.int().min(0),
  /** Gross amount the principal has committed this month, before this request. */
  budget: z.strictObject({ used_minor: MinorAmountSchema, currency: CurrencySchema }),
  /** Requests the principal created today, before this one. */
  requests_today: z.int().min(0),
  principal_throttled: z.boolean(),
  /** `pending`: the approval will be asked next; `recorded`: the principal accepted; `none`: no approval on this path. */
  approval: z.enum(["none", "pending", "recorded"]),
  /** On an approval retry: the manifest hash the approval was issued for, and the hash of the retried arguments. */
  approval_binding: z.strictObject({ issued_for: z.string().min(1), presented: z.string().min(1) }).optional(),
});
export type ValidationFacts = z.infer<typeof ValidationFactsSchema>;

export interface ValidationOptions {
  /** `approval` (default) runs every stage; `delivery` re-checks at fan-out and skips budget and throttle, already counted. */
  phase?: "approval" | "delivery";
}

export type ValidationResult =
  | { ok: true; deferred: boolean; deliver_at: string; eta: string }
  | { ok: false; error: ProtocolError; blocked?: BlockedManifest };

const DETAIL: Record<Exclude<ProtocolErrorCode, "not_found" | "invalid_transition" | "schema_invalid" | "forbidden_content" | "answer_unverified" | "unauthorized">, string> = {
  conflict: "The approval does not match these arguments.",
  principal_not_accountable: "The principal is not verified and accountable for this request.",
  principal_not_verified_for_lane: "This request type needs a real-name verified principal.",
  outside_participant_rules: "The request is outside this participant's published rules.",
  over_budget: "The bid exceeds the remaining monthly budget.",
  over_cap: "The bid exceeds the per-request cap.",
  approval_required: "This request needs the principal's approval.",
  rate_limited: "The daily request limit is reached; try again later.",
};

const CONTENT_DETAIL: Record<ForbiddenContentClass, string> = {
  persuasion_disguised: "Forbidden content: persuasion disguised as a question.",
  third_party_personal_data: "Forbidden content: personal data about someone other than the participant.",
  labour_disguised: "Forbidden content: work disguised as a question.",
};

function fail(code: ProtocolErrorCode, stage: ProtocolStage, detail: string, retryable = false): ValidationResult {
  return { ok: false, error: { code, stage, retryable, detail } };
}

function block(facts: ValidationFacts, code: ParticipantBlockCode, retryable = false): ValidationResult {
  return {
    ok: false,
    error: { code: "outside_participant_rules", stage: "rules", retryable, detail: DETAIL.outside_participant_rules },
    blocked: {
      participant_id: facts.participant.participant_id,
      principal_id: facts.principal.principal_id,
      stage: "rules",
      code,
      at: facts.now,
    },
  };
}

function parseCaller<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new TypeError(`invalid ${what} at ${r.error.issues[0]?.path.join(".") ?? "?"}`);
  return r.data;
}

// ---- quiet hours -------------------------------------------------------------

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

function clockMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Minutes since local midnight in `timeZone` at instant `ms`. Throws RangeError on an unknown zone. */
function localMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return get("hour") * 60 + get("minute");
}

function insideWindow(m: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** The instant delivery may happen: `ms` itself, or the end of the quiet window on the participant's wall clock. */
function deliveryInstant(ms: number, qh: QuietHours): number {
  const start = clockMinutes(qh.start);
  const end = clockMinutes(qh.end);
  const m = localMinutes(ms, qh.time_zone);
  if (!insideWindow(m, start, end)) return ms;
  let at = ms - (ms % MINUTE) + ((end - m + DAY_MINUTES) % DAY_MINUTES) * MINUTE;
  // Correct for an offset change (DST) inside the window, so the result is `end` local time.
  for (let i = 0; i < 2; i++) {
    let diff = end - localMinutes(at, qh.time_zone);
    if (diff > DAY_MINUTES / 2) diff -= DAY_MINUTES;
    if (diff <= -DAY_MINUTES / 2) diff += DAY_MINUTES;
    if (diff === 0) break;
    at += diff * MINUTE;
  }
  return at;
}

// ---- pipeline ----------------------------------------------------------------

/**
 * Validate a manifest against the principal, the content rules, the
 * participant's current rules, the budget and the rate limits, in that order.
 * Returns the delivery time (deferred past quiet hours when the expiry
 * allows) and the ETA, or the first failure as a `ProtocolError` whose
 * `detail` is category text only. A failure at the rules stage also returns
 * the `blocked` record to count for the participant (ids, code, time: never
 * the question). Throws a TypeError if `facts` or `policy` are malformed:
 * those are the caller's errors, not the principal's.
 */
export function validateManifest(manifest: unknown, factsIn: ValidationFacts, policyIn: ValidationPolicy, options: ValidationOptions = {}): ValidationResult {
  const facts = parseCaller(ValidationFactsSchema, factsIn, "facts");
  const policy = parseCaller(ValidationPolicySchema, policyIn, "policy");
  const phase = options.phase ?? "approval";
  const now = Date.parse(facts.now);

  // 1. schema
  const parsed = ManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") || "(root)";
    return fail("schema_invalid", "schema", `Invalid field: ${path}.`);
  }
  const m: Manifest = parsed.data;
  if (m.currency !== policy.currency) return fail("schema_invalid", "schema", "Invalid field: currency (not supported).");
  const expires = Date.parse(m.expires_at);
  if (expires <= now) return fail("schema_invalid", "schema", "Invalid field: expires_at (must be later than now).");
  if (m.to !== facts.participant.handle) throw new TypeError("facts describe another participant than the manifest's");

  // 2. principal (the approval binding first: an approval covers one manifest only)
  if (facts.approval_binding && facts.approval_binding.issued_for !== facts.approval_binding.presented) {
    return fail("conflict", "principal", DETAIL.conflict);
  }
  if (m.principal_id !== facts.principal.principal_id || !facts.principal.verified) {
    return fail("principal_not_accountable", "principal", DETAIL.principal_not_accountable);
  }
  if (m.intent === "authorisation" && facts.principal.identity_mode !== "real_name") {
    return fail("principal_not_verified_for_lane", "principal", DETAIL.principal_not_verified_for_lane);
  }

  // 3. content
  for (const text of [m.question, ...(m.options ?? []).map((o) => o.label)]) {
    const cls = classifyForbiddenContent(text);
    if (cls) return fail("forbidden_content", "content", CONTENT_DETAIL[cls]);
  }

  // 4. participant rules of engagement
  const rules = facts.participant.rules;
  const typeRule = rules.types.find((t) => t.intent === m.intent);
  if (!typeRule || !typeRule.accepted || typeRule.currency !== m.currency) return block(facts, "type_not_accepted");
  if (m.lane === "free") {
    if (m.free_lane === undefined || !rules.free_lanes.includes(m.free_lane)) return block(facts, "free_lane_mismatch");
  } else if (m.bid_minor < gross(typeRule.reserve_net_minor, policy.fee_rate)) {
    return block(facts, "bid_below_reserve");
  }
  if (rules.who_may_ask === "organisations_only" && facts.principal.identity_mode !== "verified_organisation") {
    return block(facts, "asker_not_allowed");
  }
  let deliverAt = now;
  if (rules.quiet_hours) {
    try {
      deliverAt = deliveryInstant(now, rules.quiet_hours);
    } catch {
      return block(facts, "quiet_hours"); // unknown time zone: fail closed
    }
  }
  const deferred = deliverAt !== now;
  const latency = rules.latency_promise_seconds * 1000;
  if (deferred && deliverAt + latency > expires) return block(facts, "quiet_hours", true);
  if (facts.interruptions_today >= rules.max_interruptions_per_day) return block(facts, "interruption_budget");
  if (deliverAt + latency > expires) return block(facts, "latency_mismatch");

  if (phase === "approval") {
    // 5. budget, cap, autonomy
    if (facts.budget.currency !== policy.currency) throw new TypeError("budget currency differs from the policy's");
    if (facts.budget.used_minor + m.bid_minor > policy.monthly_budget_minor) return fail("over_budget", "budget", DETAIL.over_budget);
    if (m.bid_minor > policy.per_request_cap_minor) return fail("over_cap", "budget", DETAIL.over_cap);
    if (facts.approval === "none" && (policy.ask_first_above_minor === null || m.bid_minor > policy.ask_first_above_minor)) {
      return fail("approval_required", "budget", DETAIL.approval_required);
    }
    // 6. throttle
    const limit = facts.principal_throttled ? policy.throttled_daily_limit : policy.daily_request_limit;
    if (facts.requests_today >= limit) return fail("rate_limited", "throttle", DETAIL.rate_limited, true);
  }

  return { ok: true, deferred, deliver_at: new Date(deliverAt).toISOString(), eta: new Date(deliverAt + latency).toISOString() };
}
