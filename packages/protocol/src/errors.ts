// Errors and blocked-manifest records (protocol skill §5).
import * as z from "zod";
import { DatetimeSchema, OpaqueIdSchema, RequestIdSchema } from "./primitives.ts";

export const PROTOCOL_ERROR_CODES = [
  "schema_invalid",
  "principal_not_accountable",
  "principal_not_verified_for_lane",
  "forbidden_content",
  "outside_participant_rules",
  "over_budget",
  "over_cap",
  "approval_required",
  "rate_limited",
  "not_found",
  "invalid_transition",
  "conflict",
  /** A stored answer failed signature verification at read time; it is not shown (spec answer-attestation "Stored answer that no longer verifies"). */
  "answer_unverified",
  /**
   * The connection's account cannot act as a principal (m1-hosted-connector:
   * no principal row for the token's subject yet, or no token at all where a
   * tool needs one). Sign in again; nothing was done.
   */
  "unauthorized",
] as const;
export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

export const VALIDATION_STAGES = ["schema", "principal", "content", "rules", "budget", "throttle"] as const;
export const ProtocolStageSchema = z.enum([...VALIDATION_STAGES, "lifecycle"]);
export type ProtocolStage = z.infer<typeof ProtocolStageSchema>;

/** Machine-readable details of a `rate_limited` refusal (m1-hosted-connector design D5): when to retry. */
export const RateLimitDetailsSchema = z.strictObject({
  retry_after_seconds: z.int().min(1).max(86_400),
});
export type RateLimitDetails = z.infer<typeof RateLimitDetailsSchema>;

/**
 * What a tool returns on failure. `detail` is category text for the principal:
 * never the question, never the participant's rules (reserve, quiet hours,
 * daily count), never personal data.
 */
export const ProtocolErrorSchema = z.strictObject({
  code: ProtocolErrorCodeSchema,
  stage: ProtocolStageSchema,
  retryable: z.boolean(),
  request_id: RequestIdSchema.optional(),
  detail: z.string().max(200).optional(),
  /** `rate_limited` only: when to retry. */
  details: RateLimitDetailsSchema.optional(),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

/** Participant-facing reasons; they live only in blocked-manifest records and the participant's home, never in a tool result. */
export const PARTICIPANT_BLOCK_CODES = [
  "type_not_accepted",
  "bid_below_reserve",
  "free_lane_mismatch",
  "asker_not_allowed",
  "quiet_hours",
  "interruption_budget",
  "latency_mismatch",
] as const;
export const ParticipantBlockCodeSchema = z.enum(PARTICIPANT_BLOCK_CODES);
export type ParticipantBlockCode = z.infer<typeof ParticipantBlockCodeSchema>;

/** A blocked manifest, counted for the participant: ids, stage, code and time only. No text column exists. */
export const BlockedManifestSchema = z.strictObject({
  request_id: RequestIdSchema.optional(),
  participant_id: OpaqueIdSchema,
  principal_id: OpaqueIdSchema,
  stage: z.literal("rules"),
  code: ParticipantBlockCodeSchema,
  at: DatetimeSchema,
});
export type BlockedManifest = z.infer<typeof BlockedManifestSchema>;
