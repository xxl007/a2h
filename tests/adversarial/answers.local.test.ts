// Adversarial suite, answer side, in-process: cases 10 (unsigned answer) and
// 11 (answer without attestation) of the protocol skill §12, thrown at the
// worker's answer intake, the one path every answer takes before it is
// stored (apps/worker/src/intake.ts). Real migrations and seed on PostgreSQL
// 17 in Docker, set up as a preview (apps/worker/test/lib/stage-db.ts).
// Fail closed: every forged envelope is rejected, the request stays
// `accepted`, no answer row and no event row is written.
//
// Skipped without Docker unless A2H_DB_PG_REQUIRED=1 (set in CI's `pnpm test`).
// The deployed side (no unsigned or unattested answer is ever shown) is
// answers.live.test.ts.
// Run: pnpm --filter @a2h/tests test
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { canonicalJson, importPrivateKey, SIGNED_ANSWER_FIELDS, type AnswerEnvelope } from "@a2h/protocol";
import { createPool } from "../../apps/worker/src/db.ts";
import { intakeAnswer } from "../../apps/worker/src/intake.ts";
import type { WorkerLogLine } from "../../apps/worker/src/log.ts";
import { registerStageKey } from "../../apps/worker/src/signing-keys.ts";
import { answerCount, createRequest, eventsOf, signedEnvelope, statusOf } from "../../apps/worker/test/lib/requests.ts";
import { skipWithoutDocker, startStageDb, testConfig, testSigningKey, type StageDb } from "../../apps/worker/test/lib/stage-db.ts";

const MV = "sim-mv-7f3c";

type Forgery = (e: AnswerEnvelope) => unknown;

describe("adversarial: answer intake fails closed (in-process, Postgres in Docker)", { skip: skipWithoutDocker() }, () => {
  let stage: StageDb;
  let pool: pg.Pool;
  const key = testSigningKey("a2h-pr-12-adversarial0001");
  const logs: WorkerLogLine[] = [];
  const ctx = () => ({ pool, config: testConfig(stage.db, { signing: key }), log: (l: WorkerLogLine) => logs.push(l), now: () => new Date() });

  before(async () => {
    stage = await startStageDb();
    pool = createPool(stage.db);
    await registerStageKey(pool, key);
  });
  after(async () => {
    await pool?.end();
    await stage?.stop();
  });

  /** A fresh accepted request and a genuine envelope for it, then the forgery: rejected, nothing changes. */
  async function assertRejected(label: string, forge: Forgery): Promise<void> {
    const r = await createRequest(stage.admin, { handle: MV, intent: "judgment", bid_minor: 3500, status: "accepted" });
    const genuine = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    const forged = await forge(genuine);
    const eventsBefore = await eventsOf(stage.admin, r.id);
    const result = await intakeAnswer(ctx(), forged);
    assert.equal(result.ok, false, `${label}: the forged answer was accepted`);
    assert.equal(await statusOf(stage.admin, r.id), "accepted", `${label}: the state changed`);
    assert.equal(await answerCount(stage.admin, r.id), 0, `${label}: an answer was stored`);
    assert.deepEqual(await eventsOf(stage.admin, r.id), eventsBefore, `${label}: an event was written`);
  }

  /**
   * Signs `claims` (whatever they say) with a valid key, the way a forger
   * holding the key would: Ed25519 over the canonical JSON of the signed
   * fields, bypassing signAnswer's own refusal to sign an invalid answer.
   */
  async function signedAs(signingKey: typeof key, claims: Record<string, unknown>): Promise<Record<string, unknown>> {
    const covered = Object.fromEntries(SIGNED_ANSWER_FIELDS.map((f) => [f, claims[f]]));
    const bytes = new TextEncoder().encode(canonicalJson(covered));
    const raw = await crypto.subtle.sign({ name: "Ed25519" }, await importPrivateKey(signingKey.private_key_pkcs8), bytes);
    return { ...claims, key_id: signingKey.key_id, signature: Buffer.from(raw).toString("base64") };
  }

  function without<K extends keyof AnswerEnvelope>(e: AnswerEnvelope, k: K): Partial<AnswerEnvelope> {
    const copy: Partial<AnswerEnvelope> = { ...e };
    delete copy[k];
    return copy;
  }

  test("control: the genuine envelope is accepted (the forgeries below differ from it in one way each)", async () => {
    const r = await createRequest(stage.admin, { handle: MV, intent: "judgment", bid_minor: 3500, status: "accepted" });
    const genuine = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    assert.deepEqual(await intakeAnswer(ctx(), genuine), { ok: true, replay: false });
    assert.equal(await statusOf(stage.admin, r.id), "answered");
  });

  test("case 10: unsigned answer → rejected, no state change", async () => {
    const forgeries: [string, Forgery][] = [
      ["no signature", (e) => without(e, "signature")],
      ["empty signature", (e) => ({ ...e, signature: "" })],
      ["null signature", (e) => ({ ...e, signature: null })],
      ["64 zero bytes", (e) => ({ ...e, signature: Buffer.alloc(64).toString("base64") })],
      ["random 64 bytes", (e) => ({ ...e, signature: Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff)).toString("base64") })],
      ["the display form instead of the signature", (e) => ({ ...e, signature: `a2h:sig:…${e.signature.slice(-4)}` })],
      ["no key id", (e) => without(e, "key_id")],
      ["no signed time", (e) => without(e, "signed_at")],
      ["signed time changed after signing", (e) => ({ ...e, signed_at: "2026-10-22T09:10:00+02:00" })],
      ["body changed after signing", (e) => ({ ...e, body: { verdict: "no", note: { text: "Reads as calm and factual." } } })],
      ["confidence raised after signing", (e) => ({ ...e, confidence: 5 })],
      ["another request's genuine signature", async (e) => {
        const other = await createRequest(stage.admin, { handle: MV, intent: "judgment", bid_minor: 3500, status: "accepted" });
        const theirs = await signedEnvelope(key, { request_id: other.id, participant_id: other.participant_id });
        return { ...e, signature: theirs.signature };
      }],
      ["signed by a key the platform never issued, under the platform's key id", async (e) => {
        const rogue = testSigningKey(key.key_id);
        return signedAs(rogue, { request_id: e.request_id, participant_id: e.participant_id, body: e.body, confidence: e.confidence, answered_personally: true, signed_at: e.signed_at });
      }],
      ["signed by an unknown key under its own key id", async (e) => {
        const rogue = testSigningKey("a2h-pr-12-rogue000000001");
        return signedAs(rogue, { request_id: e.request_id, participant_id: e.participant_id, body: e.body, confidence: e.confidence, answered_personally: true, signed_at: e.signed_at });
      }],
    ];
    for (const [label, forge] of forgeries) await assertRejected(label, forge);
  });

  test("case 10: an answer signed with a revoked key → rejected", async () => {
    const revoked = testSigningKey("a2h-pr-12-revoked00000001");
    // A real key the platform once held, since revoked.
    await stage.admin.query(
      `INSERT INTO signing_keys (key_id, participant_id, public_key, status, revoked_at) VALUES ($1, NULL, $2, 'revoked', now())`,
      [revoked.key_id, revoked.public_key],
    );
    await assertRejected("revoked key", (e) =>
      signedAs(revoked, { request_id: e.request_id, participant_id: e.participant_id, body: e.body, confidence: e.confidence, answered_personally: true, signed_at: e.signed_at }),
    );
  });

  test("case 11: answer without attestation (missing or not literally true) → rejected, no state change", async () => {
    const claims: [string, unknown][] = [["false", false], ["the string 'true'", "true"], ["1", 1], ["null", null]];
    const forgeries: [string, Forgery][] = [
      ["attestation removed after signing", (e) => without(e, "answered_personally")],
      ...claims.map(([label, value]): [string, Forgery] => [`attestation set to ${label} after signing`, (e) => ({ ...e, answered_personally: value })]),
      // A forger with the key signs the unattested payload itself: the signature verifies, the envelope must still fail.
      ...claims.map(([label, value]): [string, Forgery] => [
        `attestation ${label}, validly signed with the platform key`,
        (e) => signedAs(key, { request_id: e.request_id, participant_id: e.participant_id, body: e.body, confidence: e.confidence, answered_personally: value, signed_at: e.signed_at }),
      ]),
      ["attestation absent, validly signed with the platform key", (e) =>
        signedAs(key, { request_id: e.request_id, participant_id: e.participant_id, body: e.body, confidence: e.confidence, signed_at: e.signed_at })],
    ];
    for (const [label, forge] of forgeries) await assertRejected(label, forge);
  });

  test("rejections are logged with the request id and the code only", () => {
    const rejected = logs.filter((l) => l.msg === "answer rejected");
    assert.ok(rejected.length > 0);
    for (const l of rejected) {
      assert.deepEqual(Object.keys(l).sort(), ["code", "level", "msg", "request_id"].filter((k) => k !== "request_id" || l.request_id !== undefined).sort());
      assert.doesNotMatch(JSON.stringify(l), /calm and factual|signature|Margaret/i);
    }
  });
});
