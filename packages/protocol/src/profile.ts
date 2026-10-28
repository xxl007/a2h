// Participant-side published shapes: profile (what discovery shows) and rules
// of engagement (what validation enforces). PRD §6.3, §7.2, §7.3.
import * as z from "zod";
import {
  CurrencySchema,
  FreeLaneKindSchema,
  HandleSchema,
  IntentSchema,
  MinorAmountSchema,
  SecondsSchema,
} from "./primitives.ts";

/** Evidence behind a topic (PRD §7.2: job title, posts, licence; or self-declared). */
export const EvidenceLabelSchema = z.enum(["self_declared", "job_title", "posts", "licence"]);
export type EvidenceLabel = z.infer<typeof EvidenceLabelSchema>;

export const TopicSchema = z.strictObject({
  topic: z.string().min(1).max(80),
  evidence: EvidenceLabelSchema,
});
export type Topic = z.infer<typeof TopicSchema>;

/** The ranking inputs (PRD §9), returned so the agent's recommendation is auditable. */
export const RatingSummarySchema = z.strictObject({
  /** 0 to 5, one decimal; a rating, not money. */
  rating: z.number().min(0).max(5),
  answers: z.int().min(0),
  disputes_lost: z.int().min(0),
  typical_latency_seconds: SecondsSchema,
});
export type RatingSummary = z.infer<typeof RatingSummarySchema>;

/** Gross reserve (fee included) for one accepted request type, as shown to principals. */
export const GrossReserveSchema = z.strictObject({
  request_type: IntentSchema,
  reserve_gross_minor: MinorAmountSchema,
  currency: CurrencySchema,
});

/**
 * What `find_humans` returns per participant: handle and published terms only.
 * Strict: a name, an email, a URL or any other extra field is rejected
 * (spec protocol/discovery "Result shape").
 */
export const ProfileSchema = z.strictObject({
  handle: HandleSchema,
  simulated: z.boolean(),
  topics: z.array(TopicSchema).min(1),
  rating: RatingSummarySchema,
  /** `4.8 · 48 answers · 0 disputes · ~6h`, see `rankingDisplay`. */
  ranking_display: z.string(),
  latency_promise_seconds: SecondsSchema,
  reserves: z.array(GrossReserveSchema),
  free_lanes: z.array(FreeLaneKindSchema),
  identity_verified: z.boolean(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Per request type: accepted or not, and the net reserve (what the participant receives at least). */
export const TypeRuleSchema = z.strictObject({
  intent: IntentSchema,
  accepted: z.boolean(),
  reserve_net_minor: MinorAmountSchema,
  currency: CurrencySchema,
});
export type TypeRule = z.infer<typeof TypeRuleSchema>;

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour");

/** Quiet hours in the participant's IANA time zone; `start` may be later than `end` (overnight). */
export const QuietHoursSchema = z.strictObject({
  start: ClockTime,
  end: ClockTime,
  time_zone: z.string().min(1).max(64),
});
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const WhoMayAskSchema = z.enum(["anyone_verified", "organisations_only"]);
export type WhoMayAsk = z.infer<typeof WhoMayAskSchema>;

/** A participant's published rules of engagement (PRD §7.3), enforced at manifest validation. */
export const RulesOfEngagementSchema = z.strictObject({
  types: z.array(TypeRuleSchema),
  free_lanes: z.array(FreeLaneKindSchema),
  who_may_ask: WhoMayAskSchema,
  quiet_hours: QuietHoursSchema.nullable(),
  max_interruptions_per_day: z.int().min(0),
  latency_promise_seconds: SecondsSchema,
});
export type RulesOfEngagement = z.infer<typeof RulesOfEngagementSchema>;
