// Task 5.5: answer intake, the one verification path every answer takes
// (simulated answers included, task 5.3). Spec protocol/answer-attestation,
// one test per scenario, and protocol/request-lifecycle "Atomic transition"
// and "Idempotent replay" for the accepted → answered transition.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import type { AnswerEnvelope } from "@a2h/protocol";
import { createPool } from "../src/db.ts";
import { intakeAnswer } from "../src/intake.ts";
import type { WorkerLogLine } from "../src/log.ts";
import { registerStageKey } from "../src/signing-keys.ts";
import { answerCount, createRequest, eventsOf, signedEnvelope, statusOf } from "./lib/requests.ts";
import { rows, skipWithoutDocker, startStageDb, testConfig, testSigningKey, type StageDb } from "./lib/stage-db.ts";

const skip = skipWithoutDocker();
const MV = "sim-mv-7f3c"; // judgment reserve 2500 net (3125 gross at f = 0.2)

describe("answer intake", { skip }, () => {
  let stage: StageDb;
  let pool: pg.Pool;
  const key = testSigningKey("a2h-pr-12-intake00000001");
  let logs: WorkerLogLine[] = [];
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

  async function acceptedRequest() {
    return createRequest(stage.admin, { handle: MV, intent: "judgment", bid_minor: 3500, status: "accepted" });
  }

  /** Expects a rejection with `code` and no state change: still accepted, no answer, no new event. */
  async function assertRejected(input: unknown, id: string, code: string) {
    const eventsBefore = await eventsOf(stage.admin, id);
    logs = [];
    const result = await intakeAnswer(ctx(), input);
    assert.deepEqual(result, { ok: false, code });
    assert.equal(await statusOf(stage.admin, id), "accepted");
    assert.equal(await answerCount(stage.admin, id), 0);
    assert.deepEqual(await eventsOf(stage.admin, id), eventsBefore);
  }

  test("a complete, signed answer is stored: answered, one event, signed_at verbatim, gross cleared amount", async () => {
    const r = await acceptedRequest();
    const env = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    assert.deepEqual(await intakeAnswer(ctx(), env), { ok: true, replay: false });
    assert.equal(await statusOf(stage.admin, r.id), "answered");
    const events = await eventsOf(stage.admin, r.id);
    assert.deepEqual(events.at(-1), { from_status: "accepted", to_status: "answered", actor: "participant", reason_code: null });
    const stored = await rows(stage.admin, `SELECT a.signed_at, a.key_id, a.confidence, a.answered_personally, r.cleared_minor
      FROM answers a JOIN requests r ON r.id = a.request_id WHERE a.request_id = $1`, [r.id]);
    assert.deepEqual(stored[0], {
      signed_at: "2026-10-21T09:10:00+02:00",
      key_id: key.key_id,
      confidence: 4,
      answered_personally: true,
      // reserve 2500 net → 3125 gross; clear(3125, 3500, s = 0.5) = 3125 + 187.5 → 3313 (half up, once)
      cleared_minor: 3313,
    });
  });

  test("Scenario: Unsigned answer", async () => {
    const r = await acceptedRequest();
    const env: Partial<AnswerEnvelope> = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    delete env.signature;
    await assertRejected(env, r.id, "schema_invalid");
  });

  test("Scenario: Attestation missing or false", async () => {
    const r = await acceptedRequest();
    const env = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    await assertRejected({ ...env, answered_personally: false }, r.id, "schema_invalid");
    const missing: Partial<AnswerEnvelope> = { ...env };
    delete missing.answered_personally;
    await assertRejected(missing, r.id, "schema_invalid");
  });

  test("Scenario: Confidence out of range", async () => {
    const r = await acceptedRequest();
    const env = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    await assertRejected({ ...env, confidence: 0 }, r.id, "schema_invalid");
    await assertRejected({ ...env, confidence: 6 }, r.id, "schema_invalid");
  });

  test("Scenario: Body does not match the intent", async () => {
    const r = await acceptedRequest();
    // A well-formed estimate body, correctly signed, sent for a judgment request.
    const env = await signedEnvelope(key, {
      request_id: r.id,
      participant_id: r.participant_id,
      body: { estimate: 3, range: { low: 2, high: 5 }, unit: "days" },
    });
    await assertRejected(env, r.id, "schema_invalid");
  });

  test("Scenario: Tampered body", async () => {
    const r = await acceptedRequest();
    const env = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    await assertRejected({ ...env, body: { verdict: "yes", note: { text: "Reads as calm and factual!" } } }, r.id, "schema_invalid");
  });

  test("Scenario: Old key still verifies", async () => {
    const old = testSigningKey("a2h-pr-12-intakeold00001");
    await registerStageKey(pool, old);
    const r = await acceptedRequest();
    const env = await signedEnvelope(old, { request_id: r.id, participant_id: r.participant_id });
    // The stage rotates to a new key after the answer was signed.
    await registerStageKey(pool, testSigningKey("a2h-pr-12-intakenew00001"));
    const [k] = await rows<{ status: string }>(stage.admin, `SELECT status FROM signing_keys WHERE key_id = $1`, [old.key_id]);
    assert.equal(k?.status, "rotated");
    assert.deepEqual(await intakeAnswer(ctx(), env), { ok: true, replay: false });
    assert.equal(await statusOf(stage.admin, r.id), "answered");
  });

  test("Scenario: Revoked key", async () => {
    const revoked = testSigningKey("a2h-pr-12-intakerev00001");
    await registerStageKey(pool, revoked);
    await registerStageKey(pool, testSigningKey("a2h-pr-12-intakerev00002"));
    await stage.admin.query(`UPDATE signing_keys SET status = 'revoked', revoked_at = now() WHERE key_id = $1`, [revoked.key_id]);
    const r = await acceptedRequest();
    const env = await signedEnvelope(revoked, { request_id: r.id, participant_id: r.participant_id });
    await assertRejected(env, r.id, "schema_invalid");
  });

  test("an unknown key_id is rejected", async () => {
    const r = await acceptedRequest();
    const env = await signedEnvelope(testSigningKey("a2h-pr-12-neverrecorded01"), { request_id: r.id, participant_id: r.participant_id });
    await assertRejected(env, r.id, "schema_invalid");
  });

  test("an answer signed for another participant than the request's is rejected", async () => {
    const r = await acceptedRequest();
    const env = await signedEnvelope(key, { request_id: r.id, participant_id: "p_sim_th_2a91" });
    await assertRejected(env, r.id, "schema_invalid");
  });

  test("an answer to a request not yet accepted is rejected with invalid_transition and changes nothing", async () => {
    const r = await createRequest(stage.admin, { handle: MV, status: "sent" });
    const env = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    assert.deepEqual(await intakeAnswer(ctx(), env), { ok: false, code: "invalid_transition" });
    assert.equal(await statusOf(stage.admin, r.id), "sent");
    assert.equal(await answerCount(stage.admin, r.id), 0);
  });

  test("an answer for an unknown request is not_found", async () => {
    const env = await signedEnvelope(key, { request_id: "A2H-ffff", participant_id: "p_sim_mv_7f3c" });
    assert.deepEqual(await intakeAnswer(ctx(), env), { ok: false, code: "not_found" });
  });

  test("Scenario: Rejection log line", async () => {
    const r = await acceptedRequest();
    const env = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    logs = [];
    await intakeAnswer(ctx(), { ...env, confidence: 9 });
    await intakeAnswer(ctx(), { ...env, body: { verdict: "no" } });
    const rejections = logs.filter((l) => l.msg === "answer rejected");
    assert.equal(rejections.length, 2, JSON.stringify(logs));
    for (const line of rejections) {
      assert.deepEqual(Object.keys(line).sort(), ["code", "level", "msg", "request_id"]);
      assert.equal(line.request_id, r.id);
      assert.equal(line.code, "schema_invalid");
    }
    const all = JSON.stringify(logs);
    for (const leaked of ["Reads as calm", "verdict", r.participant_id, "Margaret", env.signature]) assert.ok(!all.includes(leaked), leaked);
  });

  test("Scenario: Idempotent replay (accepted → answered applied twice)", async () => {
    const r = await acceptedRequest();
    const env = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    assert.deepEqual(await intakeAnswer(ctx(), env), { ok: true, replay: false });
    const events = await eventsOf(stage.admin, r.id);
    assert.deepEqual(await intakeAnswer(ctx(), env), { ok: true, replay: true });
    assert.deepEqual(await eventsOf(stage.admin, r.id), events, "no second event row");
    assert.equal(await answerCount(stage.admin, r.id), 1);
  });

  test("Scenario: Atomic transition", async () => {
    const r = await acceptedRequest();
    // The `answered` event row cannot be written: one already exists for this
    // request (unique per target state), so the INSERT inside the transition fails.
    await stage.admin.query(`INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ($1, 'accepted', 'answered', 'participant')`, [r.id]);
    const env = await signedEnvelope(key, { request_id: r.id, participant_id: r.participant_id });
    await assert.rejects(intakeAnswer(ctx(), env));
    assert.equal(await statusOf(stage.admin, r.id), "accepted");
    assert.equal(await answerCount(stage.admin, r.id), 0);
  });
});
