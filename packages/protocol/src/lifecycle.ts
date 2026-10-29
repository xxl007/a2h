// The request state machine (protocol skill §6; spec protocol/request-lifecycle).
// Pure: the caller applies the result and writes the event row in the same
// transaction (apps/worker, apps/mcp).
import type { ProtocolError } from "./errors.ts";
import type { HoldStatus } from "./tools.ts";
import type { Actor, LifecycleEvent, RequestStatus } from "./request.ts";

/** The legal transitions: from-state → actor → event → to-state. Everything else is invalid. */
const TRANSITIONS: Readonly<Partial<Record<RequestStatus, Partial<Record<Actor, Partial<Record<LifecycleEvent, RequestStatus>>>>>>> = {
  sent: {
    participant: { accept: "accepted", decline: "declined" },
    platform: { expire: "expired" },
    principal: { cancel: "cancelled" },
  },
  accepted: {
    participant: { answer: "answered" },
    platform: { expire: "expired" },
    principal: { cancel: "cancelled" },
  },
};

/** Which state each (actor, event) leads to, for recognising replays. */
const TARGET: Readonly<Record<string, RequestStatus>> = {
  "participant|accept": "accepted",
  "participant|decline": "declined",
  "participant|answer": "answered",
  "platform|expire": "expired",
  "principal|cancel": "cancelled",
};

export type TransitionResult =
  | { ok: true; from: RequestStatus; to: RequestStatus; changed: boolean }
  | { ok: false; error: ProtocolError };

/**
 * Apply `event` by `actor` to a request in `state`. A legal transition
 * returns the new state with `changed: true`. Replaying the event that led to
 * the current state (same actor) is a no-op: `changed: false`, no event row.
 * Anything else is `invalid_transition` and the state is unchanged.
 */
export function transition(state: RequestStatus, actor: Actor, event: LifecycleEvent): TransitionResult {
  const to = TRANSITIONS[state]?.[actor]?.[event];
  if (to) return { ok: true, from: state, to, changed: true };
  if (TARGET[`${actor}|${event}`] === state) return { ok: true, from: state, to: state, changed: false };
  return {
    ok: false,
    error: { code: "invalid_transition", stage: "lifecycle", retryable: false, detail: "This change is not possible in the request's current state." },
  };
}

/** What happens to the hold in each state; a free-lane request has no hold. */
export function holdStatusAfter(state: RequestStatus, { paid }: { paid: boolean }): HoldStatus {
  if (!paid) return "none";
  switch (state) {
    case "sent":
    case "accepted":
      return "held";
    case "answered":
      return "captured";
    case "declined":
    case "expired":
    case "cancelled":
      return "released";
  }
}
