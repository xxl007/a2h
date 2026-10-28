// Inputs and outputs of the MCP tools (protocol skill §7; specs
// protocol/discovery, protocol/request-approval, protocol/request-lifecycle).
// The JSON Schema export of these is what apps/mcp registers.
import * as z from "zod";
import { AnswerEnvelopeSchema } from "./answer.ts";
import { ProfileSchema } from "./profile.ts";
import {
  CurrencySchema,
  DatetimeSchema,
  HandleSchema,
  IntentSchema,
  MinorAmountSchema,
  RequestIdSchema,
  SecondsSchema,
} from "./primitives.ts";
import { RequestStatusSchema } from "./request.ts";

export { RequestHumanInputSchema } from "./manifest.ts";

// ---- find_humans ---------------------------------------------------------

export const FindHumansInputSchema = z
  .strictObject({
    topic: z.string().min(1).max(200),
    request_type: IntentSchema,
    /** Only profiles with at least one topic evidenced by more than self-declaration. */
    attested: z.boolean().optional(),
    /** Longest acceptable latency promise, in seconds. */
    latency: SecondsSchema.optional(),
    /** Highest acceptable gross reserve, in minor units; requires `currency`. */
    max_price_minor: MinorAmountSchema.optional(),
    currency: CurrencySchema.optional(),
    location: z.string().min(1).max(100).optional(),
  })
  .refine((i) => i.max_price_minor === undefined || i.currency !== undefined, {
    message: "max_price_minor requires currency",
    path: ["currency"],
  });
export type FindHumansInput = z.infer<typeof FindHumansInputSchema>;

export const FindHumansOutputSchema = z.strictObject({
  results: z.array(ProfileSchema),
  /** The platform fee as a percentage of the cleared price; every amount above is gross (fee included). */
  fee_percent: z.number().min(0).max(100),
  /** Present when `results` is empty: widen the filters or ask for a referral. */
  hint: z.string().max(300).optional(),
});
export type FindHumansOutput = z.infer<typeof FindHumansOutputSchema>;

// ---- request_human -------------------------------------------------------

/**
 * `status: "sent"`: the request exists (`request_id`, `eta`, `held_minor`
 * gross, `deliver_at`, `deferred`). `status: "not_sent"`: the principal
 * declined or dismissed the approval; nothing exists.
 */
export const RequestHumanOutputSchema = z
  .strictObject({
    status: z.enum(["sent", "not_sent"]),
    request_id: RequestIdSchema.optional(),
    eta: DatetimeSchema.optional(),
    held_minor: MinorAmountSchema.optional(),
    currency: CurrencySchema.optional(),
    deliver_at: DatetimeSchema.optional(),
    deferred: z.boolean().optional(),
    reason: z.enum(["declined", "dismissed"]).optional(),
  })
  .superRefine((o, ctx) => {
    const sentFields = ["request_id", "eta", "held_minor", "currency", "deliver_at", "deferred"] as const;
    if (o.status === "sent") {
      for (const f of sentFields) if (o[f] === undefined) ctx.addIssue({ code: "custom", path: [f], message: `a sent result carries ${f}` });
      if (o.reason !== undefined) ctx.addIssue({ code: "custom", path: ["reason"], message: "a sent result has no reason" });
    } else {
      for (const f of sentFields) if (o[f] !== undefined) ctx.addIssue({ code: "custom", path: [f], message: `nothing was created: no ${f}` });
      if (o.reason === undefined) ctx.addIssue({ code: "custom", path: ["reason"], message: "a not-sent result says why" });
    }
  });
export type RequestHumanOutput = z.infer<typeof RequestHumanOutputSchema>;

// ---- check_requests ------------------------------------------------------

export const CheckRequestsInputSchema = z
  .strictObject({
    request_id: RequestIdSchema.optional(),
    status: RequestStatusSchema.optional(),
    since: DatetimeSchema.optional(),
    limit: z.int().min(1).max(100).optional(),
  })
  .refine((i) => i.request_id === undefined || (i.status === undefined && i.since === undefined && i.limit === undefined), {
    message: "either a request id or a filter",
    path: ["request_id"],
  });
export type CheckRequestsInput = z.infer<typeof CheckRequestsInputSchema>;

export const TransitionTimesSchema = z.strictObject({
  sent_at: DatetimeSchema,
  accepted_at: DatetimeSchema.optional(),
  answered_at: DatetimeSchema.optional(),
  declined_at: DatetimeSchema.optional(),
  expired_at: DatetimeSchema.optional(),
  cancelled_at: DatetimeSchema.optional(),
});

export const HoldStatusSchema = z.enum(["held", "released", "captured", "none"]);

/** How the principal is shown an answer (spec protocol/answer-attestation "What the principal sees"). */
export const AnswerDisplaySchema = z.strictObject({
  /** `a2h:sig:…` followed by the signature's last four characters. */
  signature: z.string().regex(/^a2h:sig:….{4}$/),
  /** `reviewed by M.V., 21 Oct 2026`. */
  citation: z.string().min(1).max(100),
  /** Present when the participant is not yet identity-verified. */
  verification_notice: z.string().max(200).optional(),
});

/**
 * One request as `check_requests` reports it. The participant's display label
 * and verification status appear only once the request was accepted; the
 * answer only when it is answered.
 */
export const CheckedRequestSchema = z
  .strictObject({
    request_id: RequestIdSchema,
    status: RequestStatusSchema,
    handle: HandleSchema,
    participant_label: z.string().min(1).max(80).optional(),
    identity_verified: z.boolean().optional(),
    simulated: z.boolean(),
    intent: IntentSchema,
    transitions: TransitionTimesSchema,
    /** Gross amount held (equals the bid); 0 on a free lane. */
    held_minor: MinorAmountSchema,
    hold_status: HoldStatusSchema,
    /** Gross cleared amount, once answered. */
    cleared_minor: MinorAmountSchema.optional(),
    currency: CurrencySchema,
    answer: AnswerEnvelopeSchema.optional(),
    answer_display: AnswerDisplaySchema.optional(),
  })
  .superRefine((r, ctx) => {
    const wasAccepted = r.transitions.accepted_at !== undefined;
    if (!wasAccepted && r.participant_label !== undefined)
      ctx.addIssue({ code: "custom", path: ["participant_label"], message: "identity is revealed on acceptance only" });
    if (!wasAccepted && r.identity_verified !== undefined)
      ctx.addIssue({ code: "custom", path: ["identity_verified"], message: "identity is revealed on acceptance only" });
    const answered = r.status === "answered";
    for (const f of ["answer", "answer_display", "cleared_minor"] as const) {
      if (answered && r[f] === undefined) ctx.addIssue({ code: "custom", path: [f], message: `an answered request carries ${f}` });
      if (!answered && r[f] !== undefined) ctx.addIssue({ code: "custom", path: [f], message: `only an answered request carries ${f}` });
    }
  });
export type CheckedRequest = z.infer<typeof CheckedRequestSchema>;

export const CheckRequestsOutputSchema = z.strictObject({ requests: z.array(CheckedRequestSchema) });
export type CheckRequestsOutput = z.infer<typeof CheckRequestsOutputSchema>;
