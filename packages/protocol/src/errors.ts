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
] as const;
export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

export const VALIDATION_STAGES = ["schema", "principal", "content", "rules", "budget", "throttle"] as const;
export const ProtocolStageSchema = z.enum([...VALIDATION_STAGES, "lifecycle"]);
export type ProtocolStage = z.infer<typeof ProtocolStageSchema>;

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
