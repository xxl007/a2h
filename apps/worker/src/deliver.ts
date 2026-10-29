// Delivery (task 5.2; spec request-lifecycle "Delivery re-validates the
// manifest"). The dispatcher finds requests that are due and not yet
// delivered and enqueues one `deliver` job each; the job re-runs the
// participant-rules validation against the rules as they are now, in one
// transaction with what it records:
// - blocked: a `blocked_manifests` row (ids and code, never the question)
//   when the participant's rules refuse it, a `blocked` delivery row, the
//   request stays `sent` until it expires; nothing reaches the participant;
// - deferred (quiet hours began): `deliver_at` moves to the end of them;
// - passes: a `delivered` row and, for a simulated participant, the persona's
//   first `simulate` job, enqueued in the same transaction.
// In this change only simulated participants have a delivery channel: a
// request to anyone else is left `sent` (a real delivery job arrives in M3).
import { and, asc, eq, gt, lte, notExists } from "drizzle-orm";
import { validateManifest, type SimulatedPersona } from "@a2h/protocol";
import { blockedManifests, participants, requestDeliveries, requests, simulatedPersonas } from "@a2h/db";
import type { JobContext } from "./context.ts";
import { dbOf, inTransaction } from "./db.ts";
import { currentRules, deliveriesToday, deliveryFacts, manifestOf } from "./manifest-facts.ts";
import { personaPlan } from "./persona.ts";
import type { Jobs } from "./queues.ts";

export interface DeliverContext extends JobContext {
  jobs: Jobs;
}

/** Most requests one dispatch pass enqueues; the next pass takes the rest. */
const DISPATCH_BATCH = 100;

/** Enqueues a deliver job for every due, undelivered `sent` request to a simulated participant. */
export async function dispatchDue(ctx: DeliverContext): Promise<number> {
  const now = ctx.now();
  const db = dbOf(ctx.pool);
  const due = await db
    .select({ id: requests.id })
    .from(requests)
    .innerJoin(participants, eq(participants.id, requests.participant_id))
    .where(
      and(
        eq(requests.status, "sent"),
        lte(requests.deliver_at, now),
        gt(requests.expires_at, now),
        eq(participants.simulated, true),
        notExists(db.select({ one: requestDeliveries.request_id }).from(requestDeliveries).where(eq(requestDeliveries.request_id, requests.id))),
      ),
    )
    .orderBy(asc(requests.deliver_at))
    .limit(DISPATCH_BATCH);
  for (const { id } of due) await ctx.jobs.deliver(id);
  return due.length;
}

export async function deliverRequest(ctx: DeliverContext, requestId: string): Promise<void> {
  const now = ctx.now();
  await inTransaction(ctx.pool, async (tx, client) => {
    const [request] = await tx.select().from(requests).where(eq(requests.id, requestId)).for("update");
    if (!request) {
      ctx.log({ level: "warn", msg: "deliver: unknown request", request_id: requestId });
      return;
    }
    const ids = { request_id: request.id, principal_id: request.principal_id, participant_id: request.participant_id };
    const [done] = await tx.select({ outcome: requestDeliveries.outcome }).from(requestDeliveries).where(eq(requestDeliveries.request_id, request.id));
    // Delivered once; a request no longer `sent` or past its expiry is left to the lifecycle.
    if (done || request.status !== "sent" || request.expires_at.getTime() <= now.getTime()) return;

    const [participant] = await tx.select().from(participants).where(eq(participants.id, request.participant_id));
    if (!participant?.simulated || !participant.persona) {
      ctx.log({ level: "info", msg: "deliver: no delivery channel for this participant yet", ...ids, state: request.status });
      return;
    }
    const facts = deliveryFacts(ctx.config, participant, await currentRules(tx, participant.id), await deliveriesToday(tx, participant.id, now), now);
    const result = validateManifest(manifestOf(request, participant.handle), facts, ctx.config.policy, { phase: "delivery" });

    if (!result.ok) {
      // Counted for the participant when their rules refused it; any other
      // failure (principal, content) is not delivered either.
      if (result.blocked) await tx.insert(blockedManifests).values({ ...result.blocked, request_id: request.id, at: now });
      await tx.insert(requestDeliveries).values({ request_id: request.id, participant_id: participant.id, outcome: "blocked", at: now });
      ctx.log({ level: "warn", msg: "delivery blocked", ...ids, state: request.status, stage: result.error.stage, code: result.blocked?.code ?? result.error.code });
      return;
    }
    if (result.deferred) {
      await tx.update(requests).set({ deliver_at: new Date(result.deliver_at), updated_at: now }).where(eq(requests.id, request.id));
      ctx.log({ level: "info", msg: "delivery deferred", ...ids, state: request.status, deliver_at: result.deliver_at });
      return;
    }
    await tx.insert(requestDeliveries).values({ request_id: request.id, participant_id: participant.id, outcome: "delivered", at: now });
    const [persona] = await tx.select().from(simulatedPersonas).where(eq(simulatedPersonas.persona, participant.persona));
    const first = personaPlan(participant.persona as SimulatedPersona, persona?.delay_seconds ?? 1)[0]!;
    await ctx.jobs.simulate(client, { request_id: request.id, step: first.step }, first.after_seconds);
    ctx.log({ level: "info", msg: "delivered", ...ids, state: request.status, persona: participant.persona });
  });
}
