// Answer bodies per intent and the signed envelope (protocol skill §4, §9;
// spec protocol/answer-attestation).
import * as z from "zod";
import {
  AttachmentSchema,
  DatetimeSchema,
  HandleSchema,
  type Intent,
  OpaqueIdSchema,
  RequestIdSchema,
  VoiceNoteSchema,
} from "./primitives.ts";

const Text = z.string().min(1).max(10000);
const NoteSchema = z
  .strictObject({ text: Text.optional(), voice: VoiceNoteSchema.optional() })
  .refine((n) => n.text !== undefined || n.voice !== undefined, "a note has text or voice");

export const ObservationBodySchema = z.strictObject({
  value: Text,
  observed_at: DatetimeSchema,
  place: z.string().min(1).max(500),
});
export const VerificationBodySchema = z.strictObject({
  verdict: z.enum(["confirm", "deny", "cant_tell"]),
  evidence: z.union([z.array(AttachmentSchema).min(1), Text]).optional(),
});
export const JudgmentBodySchema = z.strictObject({
  verdict: z.enum(["yes", "no", "cant_tell"]),
  note: NoteSchema.optional(),
});
export const OpinionBodySchema = z.union([
  z.strictObject({ choice: z.string().min(1).max(32) }),
  z.strictObject({ scale: z.number() }),
]);
export const EstimateBodySchema = z
  .strictObject({
    estimate: z.number(),
    range: z.strictObject({ low: z.number(), high: z.number() }),
    unit: z.string().min(1).max(40).optional(),
  })
  .refine((b) => b.range.low <= b.range.high, { message: "range.low must not exceed range.high", path: ["range"] });
export const KnowledgeBodySchema = z
  .strictObject({ text: Text.optional(), voice: VoiceNoteSchema.optional() })
  .refine((b) => b.text !== undefined || b.voice !== undefined, "an explanation has text or voice");
export const AuthorisationBodySchema = z
  .strictObject({ decision: z.enum(["approve", "reject", "edit"]), edit: Text.optional() })
  .refine((b) => (b.decision === "edit") === (b.edit !== undefined), { message: "edit text goes with decision edit only", path: ["edit"] });
export const ActionBodySchema = z.strictObject({ artifacts: z.array(AttachmentSchema).min(1) });
/** A referral forwards to handles, never to a contact. */
export const ReferralBodySchema = z.strictObject({
  forwarded_to: z.union([z.array(HandleSchema).min(1), z.literal("none")]),
  note: Text.optional(),
});

export const AnswerBodySchemas = {
  observation: ObservationBodySchema,
  verification: VerificationBodySchema,
  judgment: JudgmentBodySchema,
  opinion: OpinionBodySchema,
  estimate: EstimateBodySchema,
  knowledge: KnowledgeBodySchema,
  authorisation: AuthorisationBodySchema,
  action: ActionBodySchema,
  referral: ReferralBodySchema,
} as const satisfies Record<Intent, z.ZodType>;

export const AnswerBodySchema = z.union([
  ObservationBodySchema,
  VerificationBodySchema,
  JudgmentBodySchema,
  OpinionBodySchema,
  EstimateBodySchema,
  KnowledgeBodySchema,
  AuthorisationBodySchema,
  ActionBodySchema,
  ReferralBodySchema,
]);
export type AnswerBody = z.infer<typeof AnswerBodySchema>;

const unsignedFields = {
  request_id: RequestIdSchema,
  participant_id: OpaqueIdSchema,
  confidence: z.int().min(1).max(5),
  /** Literal true: v1 has no participant-side agent. */
  answered_personally: z.literal(true),
  signed_at: DatetimeSchema,
};

/** Base64 of a 64-byte Ed25519 signature. */
export const SignatureSchema = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "base64 Ed25519 signature");

/** The fields the signature covers (see `canonicalAnswerPayload`). */
export const UnsignedAnswerSchema = z.strictObject({ ...unsignedFields, body: AnswerBodySchema });
export type UnsignedAnswer = z.infer<typeof UnsignedAnswerSchema>;

export const AnswerEnvelopeSchema = z.strictObject({
  ...unsignedFields,
  body: AnswerBodySchema,
  key_id: OpaqueIdSchema,
  signature: SignatureSchema,
});
export type AnswerEnvelope = z.infer<typeof AnswerEnvelopeSchema>;

/** The envelope for a request of a given intent: the body must match that intent. */
export function answerEnvelopeSchemaFor(intent: Intent) {
  return AnswerEnvelopeSchema.extend({ body: AnswerBodySchemas[intent] });
}
