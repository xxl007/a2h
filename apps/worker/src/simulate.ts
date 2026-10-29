// The participant simulator (task 5.3; spec platform/participant-simulation;
// design D8). Plays a simulated participant's scripted persona on a request
// the deliver queue delivered: accept and answer, decline with a reason,
// accept then answer slowly, answer "can't tell", or stay silent. Answers
// are fixed templates per intent (no model is called, nothing is generated),
// signed with the stage's platform key and stored through the same intake
// as a real answer (task 5.5). Nothing leaves the worker: no email, no
// network call; only this stage's database is written.
import { eq } from "drizzle-orm";
import {
  signAnswer,
  type AnswerBody,
  type Intent,
  type SigningKey,
  type SimulatedPersona,
  type UnsignedAnswer,
} from "@a2h/protocol";
import { participants, requests, simulatedPersonas } from "@a2h/db";
import { dbOf, inTransaction } from "./db.ts";
import type { DeliverContext } from "./deliver.ts";
import { intakeAnswer } from "./intake.ts";
import { applyTransition, type RequestRow } from "./lifecycle.ts";
import { personaPlan } from "./persona.ts";
import type { SimulateJob } from "./queues.ts";

export interface SimulateContext extends DeliverContext {
  /** The stage's platform key (design D4): signs simulated answers only. */
  signer: { key_id: string; privateKey: SigningKey };
}

// ---- answer bodies: fixed templates ------------------------------------------

const NOTE = "Simulated answer from a scripted test persona (simulated). No person was asked.";
const CANT_TELL = "Can't tell (simulated). A scripted test persona answered; no person was asked.";

export interface BodyInputs {
  cantTell: boolean;
  /** The answer's signed time, used as the observation time. */
  signedAt: string;
  options: { id: string; label: string }[] | null;
  scale: { min: number; max: number } | null;
}

/** The simulated body for `intent`: deterministic, valid for the intent's answer schema, marked "(simulated)". */
export function simulatedBody(intent: Intent, { cantTell, signedAt, options, scale }: BodyInputs): AnswerBody {
  const text = cantTell ? CANT_TELL : NOTE;
  switch (intent) {
    case "observation":
      return { value: text, observed_at: signedAt, place: "Not observed: simulated participant (simulated)" };
    case "verification":
      return { verdict: cantTell ? "cant_tell" : "confirm", evidence: text };
    case "judgment":
      return { verdict: cantTell ? "cant_tell" : "yes", note: { text } };
    case "opinion":
      if (options && options.length > 0) return { choice: options[0]!.id };
      if (scale) return { scale: Math.round((scale.min + scale.max) / 2) };
      return { choice: "simulated" };
    case "estimate":
      return { estimate: 1, range: { low: 0, high: 2 }, unit: "units (simulated)" };
    case "knowledge":
      return { text };
    case "authorisation":
      // A simulated participant never authorises anything.
      return { decision: "reject" };
    case "action":
      return { artifacts: [{ ref: "simulated-artifact-none", media_type: "text/plain", size_bytes: 1 }] };
    case "referral":
      // Never a contact: a referral forwards to handles, and a simulated one to nobody.
      return { forwarded_to: "none", note: text };
  }
}

const CONFIDENCE: Record<"prompt" | "slow" | "cant_tell", 1 | 2 | 3 | 4 | 5> = { prompt: 4, slow: 3, cant_tell: 1 };

// ---- the steps -------------------------------------------------------------------

async function answer(ctx: SimulateContext, request: RequestRow, persona: "prompt" | "slow" | "cant_tell"): Promise<void> {
  const signedAt = ctx.now().toISOString();
  const unsigned: UnsignedAnswer = {
    request_id: request.id,
    participant_id: request.participant_id,
    body: simulatedBody(request.intent as Intent, {
      cantTell: persona === "cant_tell",
      signedAt,
      options: (request.options as BodyInputs["options"]) ?? null,
      scale: (request.scale as BodyInputs["scale"]) ?? null,
    }),
    confidence: CONFIDENCE[persona],
    answered_personally: true,
    signed_at: signedAt,
  };
  const signature = await signAnswer(unsigned, ctx.signer.privateKey);
  // The same verification path as a real answer.
  const result = await intakeAnswer(ctx, { ...unsigned, key_id: ctx.signer.key_id, signature });
  if (!result.ok && result.code !== "invalid_transition") {
    throw new Error(`simulated answer for ${request.id} rejected: ${result.code}`);
  }
}

/** Runs one step of the persona's plan for the request. Idempotent: a retried step changes nothing more. */
export async function runSimulateStep(ctx: SimulateContext, job: SimulateJob): Promise<void> {
  const db = dbOf(ctx.pool);
  const [request] = await db.select().from(requests).where(eq(requests.id, job.request_id));
  if (!request) {
    ctx.log({ level: "warn", msg: "simulate: unknown request", request_id: job.request_id });
    return;
  }
  const ids = { request_id: request.id, principal_id: request.principal_id, participant_id: request.participant_id };
  const [participant] = await db.select().from(participants).where(eq(participants.id, request.participant_id));
  if (!participant?.simulated || !participant.persona) {
    ctx.log({ level: "warn", msg: "simulate: not a simulated participant", ...ids });
    return;
  }
  const persona = participant.persona as SimulatedPersona;
  const now = ctx.now();
  const log = (msg: string, state: string, extra: Record<string, string> = {}) =>
    ctx.log({ level: "info", msg, ...ids, persona, step: job.step, state, ...extra });

  if (job.step === "answer") {
    if (persona === "prompt" || persona === "slow" || persona === "cant_tell") await answer(ctx, request, persona);
    log("simulated step done", (await db.select({ s: requests.status }).from(requests).where(eq(requests.id, request.id)))[0]!.s);
    return;
  }

  switch (persona) {
    case "silent":
      log("simulated participant stays silent", request.status);
      return;
    case "decline": {
      const [p] = await db.select().from(simulatedPersonas).where(eq(simulatedPersonas.persona, persona));
      const t = await inTransaction(ctx.pool, (tx) => applyTransition(tx, request.id, "participant", "decline", { now, reason_code: p?.decline_reason_code ?? "declined" }));
      log("simulated decline", t.ok ? t.request.status : request.status, t.ok ? {} : { code: t.code });
      return;
    }
    case "slow": {
      const [p] = await db.select().from(simulatedPersonas).where(eq(simulatedPersonas.persona, persona));
      const later = personaPlan(persona, p?.delay_seconds ?? 1)[1]!;
      const t = await inTransaction(ctx.pool, async (tx, client) => {
        const outcome = await applyTransition(tx, request.id, "participant", "accept", { now });
        // The answer step is enqueued with the acceptance, once.
        if (outcome.ok && outcome.changed) await ctx.jobs.simulate(client, { request_id: request.id, step: "answer" }, later.after_seconds);
        return outcome;
      });
      log("simulated accept", t.ok ? t.request.status : request.status, t.ok ? {} : { code: t.code });
      return;
    }
    case "prompt":
    case "cant_tell": {
      const t = await inTransaction(ctx.pool, (tx) => applyTransition(tx, request.id, "participant", "accept", { now }));
      if (!t.ok) {
        log("simulated accept refused", request.status, { code: t.code });
        return;
      }
      if (t.request.status === "accepted") await answer(ctx, t.request, persona);
      log("simulated step done", (await db.select({ s: requests.status }).from(requests).where(eq(requests.id, request.id)))[0]!.s);
      return;
    }
  }
}
