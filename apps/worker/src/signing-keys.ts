// The stage's platform signing key (design D4 and its amendment). At start
// the worker records the key it signs with as `active` in signing_keys and
// moves the previous platform key of the stage to `rotated`; rotated keys
// still verify (answers keep their key_id), revoked ones never do. Only the
// public half is written; the private key stays in memory.
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { importPrivateKey, importPublicKey, signAnswer, verifyAnswer, type SigningKey } from "@a2h/protocol";
import { signingKeys } from "@a2h/db";
import type pg from "pg";
import type { SigningKeyMaterial } from "./config.ts";
import { inTransaction } from "./db.ts";

/** Serialises key registration across worker tasks starting together (rolling deploy). */
const REGISTRATION_LOCK = "a2h:signing_keys:platform";

/** The private key, checked to be the pair of the published public key. */
export async function loadSigner(material: SigningKeyMaterial): Promise<SigningKey> {
  let privateKey: SigningKey;
  let publicKey: SigningKey;
  try {
    privateKey = await importPrivateKey(material.private_key_pkcs8);
    publicKey = await importPublicKey(new Uint8Array(Buffer.from(material.public_key, "base64")));
  } catch {
    throw new Error(`signing key ${material.key_id}: not an Ed25519 key pair`);
  }
  // A probe signed and verified in memory: proves the pair without exposing either half.
  const probe = {
    request_id: "A2H-0000",
    participant_id: "key-pair-check",
    confidence: 1,
    answered_personally: true as const,
    signed_at: "2026-01-01T00:00:00Z",
    body: { text: "key pair check" },
  };
  const signature = await signAnswer(probe, privateKey);
  if (!(await verifyAnswer({ ...probe, key_id: material.key_id, signature }, publicKey))) {
    throw new Error(`signing key ${material.key_id}: the public key is not the pair of the private key`);
  }
  return privateKey;
}

/**
 * Records the stage key as the active platform key. Returns the key ids it
 * moved to `rotated`. Refuses (throws) a key that is already rotated or
 * revoked, and a pair that does not match, before writing anything.
 */
export async function registerStageKey(pool: pg.Pool, material: SigningKeyMaterial): Promise<{ rotated: string[] }> {
  await loadSigner(material);
  return inTransaction(pool, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${REGISTRATION_LOCK}))`);
    const [existing] = await tx.select({ status: signingKeys.status }).from(signingKeys).where(eq(signingKeys.key_id, material.key_id));
    if (existing && existing.status !== "active") {
      throw new Error(`signing key ${material.key_id} is ${existing.status}: refusing to sign with it`);
    }
    if (existing) return { rotated: [] };
    const rotated = await tx
      .update(signingKeys)
      .set({ status: "rotated", rotated_at: sql`now()` })
      .where(and(isNull(signingKeys.participant_id), eq(signingKeys.status, "active"), ne(signingKeys.key_id, material.key_id)))
      .returning({ key_id: signingKeys.key_id });
    await tx.insert(signingKeys).values({ key_id: material.key_id, participant_id: null, public_key: material.public_key, status: "active" });
    return { rotated: rotated.map((r) => r.key_id) };
  });
}
