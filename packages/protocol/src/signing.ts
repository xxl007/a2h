// Ed25519 signatures over the canonical answer payload (design D4; protocol
// skill §9). WebCrypto only (`globalThis.crypto.subtle`, Node 22 and
// browsers): no Node module, no key generation, no key storage. Keys are
// passed in by the caller (the platform's signing service holds them).
import { type AnswerEnvelope, type UnsignedAnswer, UnsignedAnswerSchema } from "./answer.ts";
import { canonicalAnswerPayload } from "./canonical.ts";

const ED25519 = { name: "Ed25519" } as const;

type Subtle = typeof globalThis.crypto.subtle;
/** A WebCrypto key (the platform's `CryptoKey`), typed without DOM or Node globals. */
export type SigningKey = Awaited<ReturnType<Subtle["importKey"]>>;

function subtle(): Subtle {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new TypeError("WebCrypto (crypto.subtle) is not available");
  return s;
}

function assertEd25519(key: SigningKey, type: SigningKey["type"]): void {
  if (key.algorithm.name !== "Ed25519" || key.type !== type) {
    throw new TypeError(`expected an Ed25519 ${type} key`);
  }
}

/** Import a PKCS#8-encoded Ed25519 private key (non-extractable, sign only). */
export function importPrivateKey(pkcs8: Uint8Array): Promise<SigningKey> {
  return subtle().importKey("pkcs8", pkcs8 as Uint8Array<ArrayBuffer>, ED25519, false, ["sign"]);
}

/** Import a raw 32-byte Ed25519 public key (verify only). */
export function importPublicKey(raw: Uint8Array): Promise<SigningKey> {
  return subtle().importKey("raw", raw as Uint8Array<ArrayBuffer>, ED25519, true, ["verify"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function payloadBytes(answer: UnsignedAnswer | AnswerEnvelope): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalAnswerPayload(answer));
}

/**
 * Sign an answer: Ed25519 over the UTF-8 canonical payload. Returns the
 * signature in base64 (88 characters). Refuses (TypeError) a payload that is
 * not a valid unsigned answer, so an unattested answer is never signed.
 */
export async function signAnswer(answer: UnsignedAnswer, privateKey: SigningKey): Promise<string> {
  assertEd25519(privateKey, "private");
  const parsed = UnsignedAnswerSchema.safeParse(answer);
  if (!parsed.success) throw new TypeError("not a valid unsigned answer");
  const signature = await subtle().sign(ED25519, privateKey, payloadBytes(parsed.data));
  return toBase64(new Uint8Array(signature));
}

/**
 * Verify an envelope's signature against the canonical payload recomputed
 * from its fields. The caller chooses `publicKey` by the envelope's `key_id`
 * (active or rotated, never revoked). Returns false for any mismatch or
 * malformed signature.
 */
export async function verifyAnswer(envelope: AnswerEnvelope, publicKey: SigningKey): Promise<boolean> {
  assertEd25519(publicKey, "public");
  const signature = fromBase64(envelope.signature);
  if (!signature || signature.length !== 64) return false;
  let payload: Uint8Array<ArrayBuffer>;
  try {
    payload = payloadBytes(envelope);
  } catch {
    return false;
  }
  return subtle().verify(ED25519, publicKey, signature, payload);
}
