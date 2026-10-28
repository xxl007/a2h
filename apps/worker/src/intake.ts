// Answer intake (task 5.5; spec protocol/answer-attestation): the one path
// every answer takes before it is stored, simulated answers included. Order
// (protocol skill §9): parse the envelope for the request's intent → check
// it is the request's participant → look up `key_id` (active or rotated,
// never revoked or unknown) → verify Ed25519 over the canonical payload →
// only then the accepted → answered transition, the answer row and the
// cleared amount, in one transaction. A rejection changes nothing and is
// logged with the request id and the code only.
import { and, eq } from "drizzle-orm";
import {
  answerEnvelopeSchemaFor,
  clear,
  gross,
  importPublicKey,
  RequestIdSchema,
  verifiesWith,
  verifyAnswer,
  type AnswerEnvelope,
  type Intent,
  type SigningKeyStatus,
} from "@a2h/protocol";
import { answers, requests, ruleTypes, signingKeys } from "@a2h/db";
import type { JobContext } from "./context.ts";
import { dbOf, inTransaction, type Db } from "./db.ts";
import { applyTransition, type RequestRow } from "./lifecycle.ts";

export type IntakeCode = "schema_invalid" | "not_found" | "invalid_transition";
export type IntakeResult = { ok: true; replay: boolean } | { ok: false; code: IntakeCode };

function requestIdOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const parsed = RequestIdSchema.safeParse((input as Record<string, unknown>)["request_id"]);
  return parsed.success ? parsed.data : undefined;
}

/** The gross cleared amount: between the participant's gross reserve and the bid (ADR 0002 rule, s and f configured). */
async function clearedAmount(ctx: JobContext, db: Db, request: RequestRow): Promise<number> {
  if (request.lane === "free") return 0;
  const [rule] = await db
    .select({ reserve_net_minor: ruleTypes.reserve_net_minor })
    .from(ruleTypes)
    .where(and(eq(ruleTypes.participant_id, request.participant_id), eq(ruleTypes.intent, request.intent), eq(ruleTypes.currency, request.currency)));
  // Without a published reserve the principal pays what was bid at most:
  // the reserve is taken as the bid. A reserve raised above the bid after
  // acceptance never raises the price above the bid.
  const reserve = rule ? Math.min(gross(rule.reserve_net_minor, ctx.config.policy.fee_rate), request.bid_minor) : request.bid_minor;
  return clear(reserve, request.bid_minor, ctx.config.clearingShare);
}

async function verifiedEnvelope(db: Db, input: unknown, request: RequestRow): Promise<AnswerEnvelope | null> {
  const parsed = answerEnvelopeSchemaFor(request.intent as Intent).safeParse(input);
  if (!parsed.success) return null;
  const envelope = parsed.data as AnswerEnvelope;
  if (envelope.participant_id !== request.participant_id) return null;
  const [key] = await db
    .select({ public_key: signingKeys.public_key, status: signingKeys.status, participant_id: signingKeys.participant_id })
    .from(signingKeys)
    .where(eq(signingKeys.key_id, envelope.key_id));
  if (!key || !verifiesWith(key.status as SigningKeyStatus)) return null;
  // A participant's own key signs only that participant's answers; the stage's platform key (no owner) signs simulated ones.
  if (key.participant_id !== null && key.participant_id !== request.participant_id) return null;
  const publicKey = await importPublicKey(new Uint8Array(Buffer.from(key.public_key, "base64")));
  return (await verifyAnswer(envelope, publicKey)) ? envelope : null;
}

export async function intakeAnswer(ctx: JobContext, input: unknown): Promise<IntakeResult> {
  const requestId = requestIdOf(input);
  const reject = (code: IntakeCode): IntakeResult => {
    ctx.log({ level: "warn", msg: "answer rejected", request_id: requestId, code });
    return { ok: false, code };
  };
  if (!requestId) return reject("schema_invalid");

  const db = dbOf(ctx.pool);
  const [request] = await db.select().from(requests).where(eq(requests.id, requestId));
  if (!request) return reject("not_found");

  const envelope = await verifiedEnvelope(db, input, request);
  if (!envelope) return reject("schema_invalid");

  const cleared = await clearedAmount(ctx, db, request);
  const now = ctx.now();
  const outcome = await inTransaction(ctx.pool, async (tx) => {
    const t = await applyTransition(tx, requestId, "participant", "answer", { now, cleared_minor: cleared });
    if (!t.ok || !t.changed) return t;
    await tx.insert(answers).values({
      request_id: envelope.request_id,
      participant_id: envelope.participant_id,
      body: envelope.body,
      confidence: envelope.confidence,
      answered_personally: envelope.answered_personally,
      signed_at: envelope.signed_at,
      key_id: envelope.key_id,
      signature: envelope.signature,
    });
    return t;
  });
  if (!outcome.ok) return reject(outcome.code);
  if (!outcome.changed) {
    ctx.log({ level: "info", msg: "answer replay ignored", request_id: requestId, state: outcome.request.status });
    return { ok: true, replay: true };
  }
  ctx.log({
    level: "info",
    msg: "answer stored",
    request_id: requestId,
    principal_id: request.principal_id,
    participant_id: request.participant_id,
    state: "answered",
  });
  return { ok: true, replay: false };
}
