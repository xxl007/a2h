// Applying a lifecycle transition to a stored request (spec
// protocol/request-lifecycle): the state machine is the protocol's
// `transition()`; this writes the new status and its event row inside the
// caller's transaction, so both commit together or not at all ("Atomic
// transition"). A replay of the transition that led to the current state is
// a no-op with no event row ("Idempotent replay").
import { eq } from "drizzle-orm";
import { transition, type Actor, type LifecycleEvent, type RequestStatus } from "@a2h/protocol";
import { requestEvents, requests } from "@a2h/db";
import type { Db } from "./db.ts";

export type RequestRow = typeof requests.$inferSelect;

export type TransitionOutcome =
  | { ok: true; changed: boolean; request: RequestRow }
  | { ok: false; code: "not_found" | "invalid_transition"; request?: RequestRow };

export interface TransitionOptions {
  now: Date;
  /** A decline's reason, as a short code. */
  reason_code?: string;
  /** Set together with the status: the gross cleared amount on `answered`. */
  cleared_minor?: number;
}

/**
 * Locks the request row and applies (`actor`, `event`). Timing is part of
 * legality: a participant acts only before the expiry time, the platform
 * expires only at or after it.
 */
export async function applyTransition(tx: Db, requestId: string, actor: Actor, event: LifecycleEvent, opts: TransitionOptions): Promise<TransitionOutcome> {
  const [row] = await tx.select().from(requests).where(eq(requests.id, requestId)).for("update");
  if (!row) return { ok: false, code: "not_found" };
  const result = transition(row.status as RequestStatus, actor, event);
  if (!result.ok) return { ok: false, code: "invalid_transition", request: row };
  if (!result.changed) return { ok: true, changed: false, request: row };
  const expired = opts.now.getTime() >= row.expires_at.getTime();
  if (actor === "participant" && expired) return { ok: false, code: "invalid_transition", request: row };
  if (event === "expire" && !expired) return { ok: false, code: "invalid_transition", request: row };

  const [updated] = await tx
    .update(requests)
    .set({ status: result.to, updated_at: opts.now, ...(opts.cleared_minor === undefined ? {} : { cleared_minor: opts.cleared_minor }) })
    .where(eq(requests.id, requestId))
    .returning();
  await tx.insert(requestEvents).values({
    request_id: requestId,
    from_status: result.from,
    to_status: result.to,
    actor,
    reason_code: opts.reason_code ?? null,
    at: opts.now,
  });
  return { ok: true, changed: true, request: updated! };
}
