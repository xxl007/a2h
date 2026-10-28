// Primitive shapes shared by every A2H schema (protocol skill §3).
import * as z from "zod";

/** Three-letter ISO 4217 code, upper case. Every `_minor` field sits next to one. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;
export const CurrencySchema = z.string().regex(CURRENCY_PATTERN, "ISO 4217 code, upper case");
export type Currency = z.infer<typeof CurrencySchema>;

/** A non-negative amount in minor units (cents). Integers only, never floats. */
export const MinorAmountSchema = z.int().min(0);

/** A signed amount in minor units, for ledger entries (debits are negative). */
export const SignedMinorAmountSchema = z.int();

/** ISO 8601 date-time with a UTC offset or `Z`: `2026-10-21T16:42:00+02:00`. */
export const DatetimeSchema = z.iso.datetime({ offset: true });

/** Durations are whole seconds. */
export const SecondsSchema = z.int().min(0);

/** `A2H-` followed by four lower-case hex characters (spec "Identifier formats"). */
export const REQUEST_ID_PATTERN = /^A2H-[0-9a-f]{4}$/;
export const RequestIdSchema = z.string().regex(REQUEST_ID_PATTERN, "A2H- followed by four lower-case hex characters");
export type RequestId = z.infer<typeof RequestIdSchema>;

/** A short lower-case slug, a hyphen, four lower-case hex characters: `mv-7f3c`, `sim-mv-7f3c`. */
export const HANDLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{4}$/;
export const HANDLE_MAX_LENGTH = 32;
export const HandleSchema = z
  .string()
  .max(HANDLE_MAX_LENGTH)
  .regex(HANDLE_PATTERN, "lower-case slug, a hyphen and four lower-case hex characters");
export type Handle = z.infer<typeof HandleSchema>;

/** Opaque internal identifiers (participant, principal, key, ledger row). Never a name or an email. */
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
export const OPAQUE_ID_MAX_LENGTH = 64;
export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(OPAQUE_ID_MAX_LENGTH)
  .regex(OPAQUE_ID_PATTERN, "opaque identifier");

export const INTENTS = [
  "observation",
  "verification",
  "judgment",
  "opinion",
  "estimate",
  "knowledge",
  "authorisation",
  "action",
  "referral",
] as const;
export const IntentSchema = z.enum(INTENTS);
export type Intent = z.infer<typeof IntentSchema>;

export const AudienceSchema = z.enum([
  "named_individual",
  "role_qualified_first_to_accept",
  "panel_sample",
  "population_in_place",
]);
export type Audience = z.infer<typeof AudienceSchema>;

export const TimeShapeSchema = z.enum(["one_shot", "threaded", "recurring"]);
export type TimeShape = z.infer<typeof TimeShapeSchema>;

export const FormatSchema = z.enum(["single_field", "poll", "form", "upload", "voice"]);
export type Format = z.infer<typeof FormatSchema>;

export const LaneSchema = z.enum(["paid", "free", "bounty"]);
export type Lane = z.infer<typeof LaneSchema>;

/** Free lanes a participant may declare (PRD §7.3). */
export const FreeLaneKindSchema = z.enum(["own_publications", "facts_about_self"]);
export type FreeLaneKind = z.infer<typeof FreeLaneKindSchema>;

export const AttachmentSchema = z.strictObject({
  ref: OpaqueIdSchema,
  media_type: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/),
  size_bytes: z.int().min(1).max(25 * 1024 * 1024),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const VoiceNoteSchema = z.strictObject({
  audio_ref: OpaqueIdSchema,
  transcript: z.string().max(10000),
  transcript_edited: z.boolean(),
});
export type VoiceNote = z.infer<typeof VoiceNoteSchema>;
