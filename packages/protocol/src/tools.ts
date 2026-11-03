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
import { NotSentReasonSchema, RequestStatusSchema } from "./request.ts";

export { RequestHumanInputSchema } from "./manifest.ts";

// ---- ping (transport check, spec mcp-transport) --------------------------

/** Upper bound of ping's hold: 65 minutes, enough for the 61-minute "Idle stream survives" scenario. */
export const PING_MAX_HOLD_SECONDS = 3900;

export const PingInputSchema = z.strictObject({
  holdSeconds: z.int().min(0).max(PING_MAX_HOLD_SECONDS).optional().describe(`Seconds to wait before answering, 0 to ${PING_MAX_HOLD_SECONDS}.`),
});
export type PingInput = z.infer<typeof PingInputSchema>;

// ---- find_humans ---------------------------------------------------------

export const FindHumansInputSchema = z
  .strictObject({
    topic: z.string().min(1).max(200).describe("What the person must know about, in plain words."),
    request_type: IntentSchema.describe("The intent of the request you would send."),
    /** Only profiles with at least one topic evidenced by more than self-declaration. */
    attested: z.boolean().optional().describe("Only profiles with expertise evidenced by more than self-declaration."),
    /** Longest acceptable latency promise, in seconds. */
    latency: SecondsSchema.optional().describe("Longest acceptable latency promise, in seconds."),
    /** Highest acceptable gross reserve, in minor units; requires `currency`. */
    max_price_minor: MinorAmountSchema.optional().describe("Highest acceptable gross reserve, in minor units; requires currency."),
    currency: CurrencySchema.optional().describe("ISO 4217 code of max_price_minor."),
    location: z.string().min(1).max(100).optional().describe("Where the person should be, for observation requests."),
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
 * The result of `request_human` (m2-approval-page, spec protocol/schemas
 * "Request outcome and lane are explicit"). `awaiting_approval`: the request
 * is recorded, nothing is held or delivered, and its principal decides on
 * the approval page at `approval_url` until `approval_expires_at`.
 * `not_sent`: the principal refused to open the link where the client asked
 * through URL elicitation (`declined`), or the link expired (`expired`); the
 * request id stays, nothing was held or delivered.
 */
export const RequestHumanOutputSchema = z
  .strictObject({
    status: z.enum(["awaiting_approval", "not_sent"]),
    request_id: RequestIdSchema,
    approval_url: z.url({ protocol: /^https$/ }).max(500).optional(),
    approval_expires_at: DatetimeSchema.optional(),
    reason: NotSentReasonSchema.optional(),
  })
  .superRefine((o, ctx) => {
    const awaiting = o.status === "awaiting_approval";
    for (const f of ["approval_url", "approval_expires_at"] as const) {
      if (awaiting && o[f] === undefined) ctx.addIssue({ code: "custom", path: [f], message: `an awaiting result carries ${f}` });
      if (!awaiting && o[f] !== undefined) ctx.addIssue({ code: "custom", path: [f], message: `a not-sent result has no ${f}` });
    }
    if (awaiting && o.reason !== undefined) ctx.addIssue({ code: "custom", path: ["reason"], message: "an awaiting result has no reason" });
    if (!awaiting && o.reason === undefined) ctx.addIssue({ code: "custom", path: ["reason"], message: "a not-sent result says why" });
  });
export type RequestHumanOutput = z.infer<typeof RequestHumanOutputSchema>;


// ---- check_requests ------------------------------------------------------

export const CheckRequestsInputSchema = z
  .strictObject({
    request_id: RequestIdSchema.optional().describe("One request, e.g. A2H-7f3c. Omit to list with a filter."),
    status: RequestStatusSchema.optional().describe("Filter: only requests in this status."),
    since: DatetimeSchema.optional().describe("Filter: only requests sent at or after this time."),
    limit: z.int().min(1).max(100).optional().describe("Filter: at most this many requests, newest first."),
  })
  .refine((i) => i.request_id === undefined || (i.status === undefined && i.since === undefined && i.limit === undefined), {
    message: "either a request id or a filter",
    path: ["request_id"],
  });
export type CheckRequestsInput = z.infer<typeof CheckRequestsInputSchema>;

/**
 * When each step happened. `awaiting_approval_at` is the creation (absent on
 * requests created before m2-approval-page); `sent_at` only once the
 * principal sent it; `not_sent_at` when they did not, or the link expired.
 */
export const TransitionTimesSchema = z.strictObject({
  awaiting_approval_at: DatetimeSchema.optional(),
  not_sent_at: DatetimeSchema.optional(),
  sent_at: DatetimeSchema.optional(),
  accepted_at: DatetimeSchema.optional(),
  answered_at: DatetimeSchema.optional(),
  declined_at: DatetimeSchema.optional(),
  expired_at: DatetimeSchema.optional(),
  cancelled_at: DatetimeSchema.optional(),
});

export const HoldStatusSchema = z.enum(["held", "released", "captured", "none"]);
export type HoldStatus = z.infer<typeof HoldStatusSchema>;

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
    /** Gross amount held (equals the bid); 0 on a free lane; absent before sending and when never sent. */
    held_minor: MinorAmountSchema.optional(),
    hold_status: HoldStatusSchema,
    /** Gross cleared amount, once answered. */
    cleared_minor: MinorAmountSchema.optional(),
    currency: CurrencySchema,
    answer: AnswerEnvelopeSchema.optional(),
    answer_display: AnswerDisplaySchema.optional(),
    /** While awaiting approval: the link (left out if it can no longer be rebuilt) and when it expires. */
    approval_url: z.url({ protocol: /^https$/ }).max(500).optional(),
    approval_expires_at: DatetimeSchema.optional(),
    /** When not sent: why. */
    reason: NotSentReasonSchema.optional(),
  })
  .superRefine((r, ctx) => {
    const unsent = r.status === "awaiting_approval" || r.status === "not_sent";
    if (unsent) {
      if (r.held_minor !== undefined) ctx.addIssue({ code: "custom", path: ["held_minor"], message: "nothing is held before sending" });
      if (r.hold_status !== "none") ctx.addIssue({ code: "custom", path: ["hold_status"], message: "nothing is held before sending" });
      if (r.transitions.sent_at !== undefined) ctx.addIssue({ code: "custom", path: ["transitions", "sent_at"], message: "not sent" });
    } else {
      if (r.held_minor === undefined) ctx.addIssue({ code: "custom", path: ["held_minor"], message: "a sent request reports its held amount" });
      if (r.transitions.sent_at === undefined) ctx.addIssue({ code: "custom", path: ["transitions", "sent_at"], message: "a sent request has sent_at" });
    }
    const awaiting = r.status === "awaiting_approval";
    if (awaiting && r.approval_expires_at === undefined) ctx.addIssue({ code: "custom", path: ["approval_expires_at"], message: "an awaiting request carries the link's expiry" });
    if (!awaiting) {
      for (const f of ["approval_url", "approval_expires_at"] as const) {
        if (r[f] !== undefined) ctx.addIssue({ code: "custom", path: [f], message: "only an awaiting request carries the link" });
      }
    }
    if ((r.status === "not_sent") !== (r.reason !== undefined)) ctx.addIssue({ code: "custom", path: ["reason"], message: "a reason exactly when not sent" });
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
