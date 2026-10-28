// The manifest: the request as the principal approves it and as it will be
// delivered (protocol skill §2, §4, §5).
import * as z from "zod";
import {
  AttachmentSchema,
  AudienceSchema,
  CurrencySchema,
  DatetimeSchema,
  FormatSchema,
  FreeLaneKindSchema,
  HandleSchema,
  IntentSchema,
  LaneSchema,
  MinorAmountSchema,
  OpaqueIdSchema,
  TimeShapeSchema,
} from "./primitives.ts";

export const QUESTION_MAX_LENGTH = 2000;
export const ATTACHMENTS_MAX = 5;

/** Data terms (PRD §11): storage scope, attribution, training (default off, opt-in per request by the participant). */
export const DataTermsSchema = z.strictObject({
  storage: z.enum(["principal_workspace"]),
  attribution: z.enum(["attributed", "not_attributed"]),
  training: z.enum(["off", "participant_opt_in"]),
});
export type DataTerms = z.infer<typeof DataTermsSchema>;

/** The accountable principal behind a connection (PRD §6.2 identity modes). */
export const PrincipalSchema = z.strictObject({
  principal_id: OpaqueIdSchema,
  identity_mode: z.enum(["real_name", "verified_organisation", "verified_pseudonymous"]),
  verified: z.boolean(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

const PollOptionSchema = z.strictObject({ id: z.string().min(1).max(32), label: z.string().min(1).max(200) });

const requestFields = {
  to: HandleSchema.describe("Handle of the participant, from find_humans (e.g. mv-7f3c)."),
  intent: IntentSchema.describe("What kind of answer is wanted; fixes the answer schema."),
  audience: AudienceSchema.describe("Who receives it; named_individual in this version."),
  time_shape: TimeShapeSchema.describe("one_shot, threaded (priced per round) or recurring."),
  format: FormatSchema.describe("How the participant answers."),
  question: z
    .string()
    .max(QUESTION_MAX_LENGTH)
    .refine((q) => q.trim().length > 0, "question must not be empty")
    .describe("The question, verbatim. The principal approves this exact text before anything is sent."),
  /** Poll options for `opinion` with a `choice` answer. */
  options: z.array(PollOptionSchema).min(2).max(10).optional(),
  /** Declared scale for `opinion` with a `scale` answer. */
  scale: z.strictObject({ min: z.int(), max: z.int() }).optional(),
  lane: LaneSchema.describe("paid (bid at least the gross reserve) or free (a free lane the participant declared)."),
  /** Required when `lane` is `free`: which declared free lane this request falls under. */
  free_lane: FreeLaneKindSchema.optional(),
  /** Gross bid (fee included); the hold equals it. 0 on a free lane. */
  bid_minor: MinorAmountSchema.describe("Gross bid in minor units (cents), fee included. The hold equals the bid; the principal pays what clears, never more."),
  currency: CurrencySchema.describe("ISO 4217 code of bid_minor, e.g. EUR."),
  expires_at: DatetimeSchema.describe("ISO 8601 date-time with offset after which the request expires and the hold is released."),
  data_terms: DataTermsSchema.describe("Storage, attribution and training terms shown to the participant before acceptance."),
  attachments: z.array(AttachmentSchema).max(ATTACHMENTS_MAX).optional(),
};

type LaneFields = { lane: "paid" | "free" | "bounty"; free_lane?: unknown; bid_minor: number };

function laneIsCoherent(m: LaneFields, ctx: z.RefinementCtx): void {
  if (m.lane === "free") {
    if (m.free_lane === undefined) ctx.addIssue({ code: "custom", path: ["free_lane"], message: "a free-lane request names its free lane" });
    if (m.bid_minor !== 0) ctx.addIssue({ code: "custom", path: ["bid_minor"], message: "a free-lane request bids 0" });
  } else {
    if (m.free_lane !== undefined) ctx.addIssue({ code: "custom", path: ["free_lane"], message: "only a free-lane request names a free lane" });
    if (m.bid_minor <= 0) ctx.addIssue({ code: "custom", path: ["bid_minor"], message: "a paid request bids more than 0" });
  }
}

/** `request_human` arguments: the manifest without the principal, which comes from the connection. */
export const RequestHumanInputObject = z.strictObject(requestFields);
export const RequestHumanInputSchema = RequestHumanInputObject.superRefine(laneIsCoherent);
export type RequestHumanInput = z.infer<typeof RequestHumanInputSchema>;

/** The validated manifest: the tool arguments plus the accountable principal. */
export const ManifestSchema = RequestHumanInputObject.extend({ principal_id: OpaqueIdSchema }).superRefine(laneIsCoherent);
export type Manifest = z.infer<typeof ManifestSchema>;
