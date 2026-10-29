// Expiry (task 5.4; spec request-lifecycle "Expiry by the platform"): every
// `sent` or `accepted` request past its expiry time becomes `expired`, by the
// platform, with its event row; its hold is then reported as released
// (`holdStatusAfter`). Idempotent: an expired request is not touched again,
// and two workers expiring the same request write one event between them.
import { and, asc, inArray, lte } from "drizzle-orm";
import { requests } from "@a2h/db";
import type { JobContext } from "./context.ts";
import { dbOf, inTransaction } from "./db.ts";
import { applyTransition } from "./lifecycle.ts";

const EXPIRE_BATCH = 500;

/** Expires every due request; returns how many changed state. */
export async function expireDue(ctx: JobContext): Promise<number> {
  const now = ctx.now();
  const due = await dbOf(ctx.pool)
    .select({ id: requests.id })
    .from(requests)
    .where(and(inArray(requests.status, ["sent", "accepted"]), lte(requests.expires_at, now)))
    .orderBy(asc(requests.expires_at))
    .limit(EXPIRE_BATCH);
  let expired = 0;
  for (const { id } of due) {
    const outcome = await inTransaction(ctx.pool, (tx) => applyTransition(tx, id, "platform", "expire", { now }));
    if (outcome.ok && outcome.changed) {
      expired += 1;
      const r = outcome.request;
      ctx.log({ level: "info", msg: "request expired", request_id: r.id, principal_id: r.principal_id, participant_id: r.participant_id, state: r.status });
    }
  }
  return expired;
}
