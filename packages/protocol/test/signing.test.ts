// Design D4; spec protocol/answer-attestation "Signature covers the canonical
// payload" ("Tampered body"). Keys are generated here, in the test, and
// passed in: the package never generates or stores a key.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { AnswerEnvelopeSchema, importPrivateKey, importPublicKey, signAnswer, verifyAnswer } from "../src/index.ts";
import type { webcrypto } from "node:crypto";
import type { AnswerEnvelope } from "../src/index.ts";

type CryptoKeyPair = webcrypto.CryptoKeyPair;
import { referenceUnsigned } from "./fixtures.ts";

const { subtle } = globalThis.crypto;
let keys: CryptoKeyPair;
let other: CryptoKeyPair;
let envelope: AnswerEnvelope;

before(async () => {
  keys = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  other = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  envelope = { ...referenceUnsigned, key_id: "k-test-1", signature: await signAnswer(referenceUnsigned, keys.privateKey) };
});

describe("signAnswer / verifyAnswer (WebCrypto Ed25519, keys as arguments)", () => {
  test("sign then verify: the signature is base64 Ed25519 and verifies with the matching public key", async () => {
    assert.ok(AnswerEnvelopeSchema.safeParse(envelope).success, "signed envelope is schema-valid");
    assert.equal(await verifyAnswer(envelope, keys.publicKey), true);
  });

  test("Scenario: Tampered body — one changed character fails verification", async () => {
    const note = (envelope.body as { note: { text: string } }).note.text;
    const tampered = { ...envelope, body: { verdict: "yes", note: { text: note.replace("C", "c") } } } as AnswerEnvelope;
    assert.equal(await verifyAnswer(tampered, keys.publicKey), false);
  });

  test("any other signed field changed fails verification too", async () => {
    const variants: Partial<AnswerEnvelope>[] = [
      { confidence: 5 },
      { signed_at: "2026-10-21T09:10:01+02:00" },
      { request_id: "A2H-7f3d" },
      { participant_id: "p_other" },
    ];
    for (const v of variants) assert.equal(await verifyAnswer({ ...envelope, ...v }, keys.publicKey), false, JSON.stringify(v));
  });

  test("a one-character change in the signature fails verification", async () => {
    const s = envelope.signature;
    const flipped = (s[0] === "A" ? "B" : "A") + s.slice(1);
    assert.equal(await verifyAnswer({ ...envelope, signature: flipped }, keys.publicKey), false);
  });

  test("a wrong key fails verification", async () => {
    assert.equal(await verifyAnswer(envelope, other.publicKey), false);
  });

  test("key_id is not covered: the caller picks the key by key_id, the signature binds the content", async () => {
    assert.equal(await verifyAnswer({ ...envelope, key_id: "k-renamed" }, keys.publicKey), true);
  });

  test("a malformed signature is a failed verification, not a crash", async () => {
    assert.equal(await verifyAnswer({ ...envelope, signature: "not base64!" }, keys.publicKey), false);
    assert.equal(await verifyAnswer({ ...envelope, signature: "" }, keys.publicKey), false);
  });

  test("key material as bytes: PKCS#8 private key and raw 32-byte public key", async () => {
    const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", keys.privateKey));
    const raw = new Uint8Array(await subtle.exportKey("raw", keys.publicKey));
    assert.equal(raw.length, 32);
    const priv = await importPrivateKey(pkcs8);
    const pub = await importPublicKey(raw);
    const signature = await signAnswer(referenceUnsigned, priv);
    assert.equal(signature, envelope.signature, "Ed25519 is deterministic");
    assert.equal(await verifyAnswer(envelope, pub), true);
  });

  test("a key of another algorithm is refused", async () => {
    const ecdsa = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    await assert.rejects(() => signAnswer(referenceUnsigned, ecdsa.privateKey), TypeError);
    await assert.rejects(() => verifyAnswer(envelope, ecdsa.publicKey), TypeError);
  });

  test("an unsigned payload that is schema-invalid is not signed", async () => {
    await assert.rejects(() => signAnswer({ ...referenceUnsigned, answered_personally: false } as never, keys.privateKey), TypeError);
  });
});
