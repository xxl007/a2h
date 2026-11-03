// Requests, their closed status set and their events (protocol skill §6;
// spec protocol/request-lifecycle).
import * as z from "zod";
import { DatetimeSchema, RequestIdSchema } from "./primitives.ts";

/**
 * A request starts in `awaiting_approval` (m2-approval-page): validated,
 * recorded, nothing held or delivered, until its principal decides on the
 * approval page (`sent`) or refuses or lets the link expire (`not_sent`).
 */
export const REQUEST_STATUSES = ["awaiting_approval", "not_sent", "sent", "accepted", "answered", "declined", "expired", "cancelled"] as const;
export const RequestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export const TERMINAL_STATUSES = ["not_sent", "answered", "declined", "expired", "cancelled"] as const satisfies readonly RequestStatus[];

/** Why a request was never sent: the principal chose Don't send (`declined`), or the approval link expired. */
export const NotSentReasonSchema = z.enum(["declined", "expired"]);
export type NotSentReason = z.infer<typeof NotSentReasonSchema>;

export const ActorSchema = z.enum(["participant", "principal", "platform"]);
export type Actor = z.infer<typeof ActorSchema>;

/** `approve`: the principal's Send on the approval page; `decline` by the principal there is Don't send. */
export const LifecycleEventSchema = z.enum(["approve", "accept", "decline", "answer", "expire", "cancel"]);
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

/** One row per state transition. `from` is null for creation. */
export const RequestEventSchema = z.strictObject({
  request_id: RequestIdSchema,
  from: RequestStatusSchema.nullable(),
  to: RequestStatusSchema,
  actor: ActorSchema,
  at: DatetimeSchema,
});
export type RequestEvent = z.infer<typeof RequestEventSchema>;

/**
 * What the platform did with a request at delivery time, after re-running
 * the participant-rules validation against the current rules (spec
 * request-lifecycle "Delivery re-validates the manifest"): `delivered`, or
 * `blocked` (counted in blocked manifests, the request stays `sent` until it
 * expires). One outcome per request.
 */
export const DELIVERY_OUTCOMES = ["delivered", "blocked"] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];
