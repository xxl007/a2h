// Canonical JSON and the canonical answer payload (protocol skill §9; spec
// protocol/schemas "Canonical answer payload"). This is the only
// canonicalisation: the signer, the verifier and the tests all import it.
import type { AnswerEnvelope, UnsignedAnswer } from "./answer.ts";

/**
 * JSON with object keys sorted (by UTF-16 code unit) at every level, no
 * whitespace, array order kept, undefined members omitted. Strings are
 * JSON-escaped as `JSON.stringify` does; encode the result as UTF-8 to sign.
 * Throws a TypeError on a value JSON cannot carry (NaN, Infinity, BigInt,
 * functions, symbols).
 */
export function canonicalJson(value: unknown): string {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot carry a non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot carry a ${typeof value}`);
  }
}

/** The fields an answer signature covers, in canonical order. */
export const SIGNED_ANSWER_FIELDS = [
  "answered_personally",
  "body",
  "confidence",
  "participant_id",
  "request_id",
  "signed_at",
] as const satisfies readonly (keyof UnsignedAnswer)[];

/**
 * The canonical payload of an answer: exactly the six signed fields of the
 * envelope (any other member, such as `key_id` or `signature`, is ignored),
 * as canonical JSON. Throws a TypeError if a signed field is absent.
 */
export function canonicalAnswerPayload(answer: UnsignedAnswer | AnswerEnvelope): string {
  const source = answer as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of SIGNED_ANSWER_FIELDS) {
    if (source[field] === undefined) throw new TypeError(`signed field ${field} is missing`);
    picked[field] = source[field];
  }
  return canonicalJson(picked);
}

/**
 * SHA-256 (lower-case hex) of the canonical JSON of `request_human`
 * arguments: what an approval state binds, so that an approval replayed with
 * different arguments is detected (`conflict`). WebCrypto only.
 */
export async function manifestHash(args: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new TypeError("WebCrypto (crypto.subtle) is not available");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(args)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
