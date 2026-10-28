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
  to: HandleSchema,
  intent: IntentSchema,
  audience: AudienceSchema,
  time_shape: TimeShapeSchema,
  format: FormatSchema,
  question: z
    .string()
    .max(QUESTION_MAX_LENGTH)
    .refine((q) => q.trim().length > 0, "question must not be empty"),
  /** Poll options for `opinion` with a `choice` answer. */
  options: z.array(PollOptionSchema).min(2).max(10).optional(),
  /** Declared scale for `opinion` with a `scale` answer. */
  scale: z.strictObject({ min: z.int(), max: z.int() }).optional(),
  lane: LaneSchema,
  /** Required when `lane` is `free`: which declared free lane this request falls under. */
  free_lane: FreeLaneKindSchema.optional(),
  /** Gross bid (fee included); the hold equals it. 0 on a free lane. */
  bid_minor: MinorAmountSchema,
  currency: CurrencySchema,
  expires_at: DatetimeSchema,
  data_terms: DataTermsSchema,
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
