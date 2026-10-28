// Requests, their closed status set and their events (protocol skill §6;
// spec protocol/request-lifecycle).
import * as z from "zod";
import { DatetimeSchema, RequestIdSchema } from "./primitives.ts";

export const REQUEST_STATUSES = ["sent", "accepted", "answered", "declined", "expired", "cancelled"] as const;
export const RequestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export const TERMINAL_STATUSES = ["answered", "declined", "expired", "cancelled"] as const satisfies readonly RequestStatus[];

export const ActorSchema = z.enum(["participant", "principal", "platform"]);
export type Actor = z.infer<typeof ActorSchema>;

export const LifecycleEventSchema = z.enum(["accept", "decline", "answer", "expire", "cancel"]);
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
