// Task 5.3: the `simulate` queue plays the scripted personas (spec
// platform/participant-simulation "Scripted personas", "Simulated answers are
// genuine envelopes", "Simulation is unmistakable"). Answers go through the
// same intake as a real answer (task 5.5).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import {
  AnswerBodySchemas,
  AnswerEnvelopeSchema,
  INTENTS,
  SIMULATED_MAX_DELAY_SECONDS,
  SIMULATED_PERSONAS,
  answerEnvelopeSchemaFor,
  holdStatusAfter,
  importPublicKey,
  verifyAnswer,
  type AnswerEnvelope,
  type Intent,
} from "@a2h/protocol";
import { createPool } from "../src/db.ts";
import { expireDue } from "../src/expire.ts";
import type { WorkerLogLine } from "../src/log.ts";
import { personaPlan } from "../src/persona.ts";
import type { Jobs } from "../src/queues.ts";
import { loadSigner, registerStageKey } from "../src/signing-keys.ts";
import { runSimulateStep, simulatedBody, type SimulateContext } from "../src/simulate.ts";
import { jobsFor, startBoss } from "./lib/boss.ts";
import { answerCount, createRequest, eventsOf, statusOf } from "./lib/requests.ts";
import { skipWithoutDocker, startStageDb, testConfig, testSigningKey, type StageDb } from "./lib/stage-db.ts";

const skip = skipWithoutDocker();

describe("persona timing and answer bodies (no database)", () => {
  test("every persona acts within its delay, under two minutes; slow accepts first and answers at its delay", () => {
    for (const persona of SIMULATED_PERSONAS) {
      for (const delay of [1, 20, 100, SIMULATED_MAX_DELAY_SECONDS]) {
        const plan = personaPlan(persona, delay);
        const total = plan.reduce((s, p) => s + p.after_seconds, 0);
        assert.ok(total <= Math.max(delay, 2) && total < 120, `${persona} ${delay}: ${total}`);
        assert.equal(plan[0]!.step, "act");
      }
    }
    assert.deepEqual(personaPlan("slow", 100), [{ step: "act", after_seconds: 25 }, { step: "answer", after_seconds: 75 }]);
    assert.deepEqual(personaPlan("prompt", 20), [{ step: "act", after_seconds: 20 }]);
  });

  const at = "2026-10-21T09:10:00.000Z";
  for (const intent of INTENTS) {
    test(`${intent}: the simulated body matches the intent's answer schema, for an answer and for can't tell`, () => {
      for (const cantTell of [false, true]) {
        const body = simulatedBody(intent, { cantTell, signedAt: at, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], scale: null });
        const parsed = AnswerBodySchemas[intent].safeParse(body);
        assert.ok(parsed.success, `${intent} cant_tell=${cantTell}: ${JSON.stringify(body)}`);
        // Fixed templates, no model: the same request gives the same body.
        assert.deepEqual(simulatedBody(intent, { cantTell, signedAt: at, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], scale: null }), body);
      }
    });
  }

  test("verdict-bearing intents answer cant_tell for the can't tell persona", () => {
    const opts = { cantTell: true, signedAt: at, options: null, scale: null };
    assert.equal((simulatedBody("judgment", opts) as { verdict: string }).verdict, "cant_tell");
    assert.equal((simulatedBody("verification", opts) as { verdict: string }).verdict, "cant_tell");
  });

  test("free text says it is simulated; a simulated participant never authorises and never refers to a contact", () => {
    for (const intent of ["observation", "verification", "judgment", "knowledge", "referral", "estimate"] as const) {
      assert.match(JSON.stringify(simulatedBody(intent, { cantTell: false, signedAt: at, options: null, scale: null })), /\(simulated\)/, intent);
    }
    assert.deepEqual(simulatedBody("authorisation", { cantTell: false, signedAt: at, options: null, scale: null }), { decision: "reject" });
    assert.equal((simulatedBody("referral", { cantTell: false, signedAt: at, options: null, scale: null }) as { forwarded_to: unknown }).forwarded_to, "none");
  });

  test("opinion picks a declared option, or the middle of a declared scale", () => {
    const base = { cantTell: false, signedAt: at };
    assert.deepEqual(simulatedBody("opinion", { ...base, options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], scale: null }), { choice: "x" });
    assert.deepEqual(simulatedBody("opinion", { ...base, options: null, scale: { min: 1, max: 5 } }), { scale: 3 });
  });
});

describe("simulate queue", { skip }, () => {
  let stage: StageDb;
  let pool: pg.Pool;
  let jobs: Jobs;
  let stopBoss: () => Promise<void>;
  let logs: WorkerLogLine[] = [];
  const key = testSigningKey("a2h-pr-12-simulate000001");
  let ctx: () => SimulateContext;
  let clock = () => new Date();

  before(async () => {
    stage = await startStageDb();
    pool = createPool(stage.db);
    ({ jobs, stop: stopBoss } = await startBoss(stage));
    await registerStageKey(pool, key);
    const privateKey = await loadSigner(key);
    ctx = () => ({
      pool,
      config: testConfig(stage.db, { signing: key }),
      log: (l: WorkerLogLine) => logs.push(l),
      now: () => clock(),
      jobs,
      signer: { key_id: key.key_id, privateKey },
    });
  });
  after(async () => {
    await stopBoss?.();
    await pool?.end();
    await stage?.stop();
  });

  async function storedEnvelope(id: string): Promise<AnswerEnvelope> {
    const { rows } = await stage.admin.query(
      `SELECT request_id, participant_id, body, confidence, answered_personally, signed_at, key_id, signature FROM answers WHERE request_id = $1`,
      [id],
    );
    return rows[0] as AnswerEnvelope;
  }

  test("Scenario: Prompt answer", async () => {
    const r = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500 });
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    assert.equal(await statusOf(stage.admin, r.id), "answered");
    assert.deepEqual((await eventsOf(stage.admin, r.id)).map((e) => [e.to_status, e.actor]), [["sent", "principal"], ["accepted", "participant"], ["answered", "participant"]]);
    const env = await storedEnvelope(r.id);
    assert.ok(answerEnvelopeSchemaFor("judgment").safeParse(env).success, "a body matching the request's intent");
    assert.notEqual((env.body as { verdict: string }).verdict, "cant_tell");
  });

  test("Scenario: Decline", async () => {
    // sim-rc-8d14 is the declining persona.
    const r = await createRequest(stage.admin, { handle: "sim-rc-8d14", intent: "knowledge", bid_minor: 3200 });
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    assert.equal(await statusOf(stage.admin, r.id), "declined");
    assert.deepEqual((await eventsOf(stage.admin, r.id)).at(-1), { from_status: "sent", to_status: "declined", actor: "participant", reason_code: "outside_expertise" });
    // Nothing is charged: no cleared amount, the hold is released, no answer.
    const { rows } = await stage.admin.query(`SELECT cleared_minor FROM requests WHERE id = $1`, [r.id]);
    assert.equal(rows[0].cleared_minor, null);
    assert.equal(holdStatusAfter("declined", { paid: true }), "released");
    assert.equal(await answerCount(stage.admin, r.id), 0);
  });

  test("Scenario: Can't tell", async () => {
    // sim-ag-3b62 is the can't-tell persona; verification has a cant_tell verdict.
    const r = await createRequest(stage.admin, { handle: "sim-ag-3b62", intent: "verification", bid_minor: 3800 });
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    assert.equal(await statusOf(stage.admin, r.id), "answered");
    const env = await storedEnvelope(r.id);
    assert.equal((env.body as { verdict: string }).verdict, "cant_tell");
    // Otherwise complete: the full envelope, attested, signed.
    assert.ok(AnswerEnvelopeSchema.safeParse(env).success, JSON.stringify(env));
    assert.equal(env.answered_personally, true);
  });

  test("slow persona: accepts first, answers at its delay", async () => {
    // sim-ep-5c07 is slow (100 s in the seed): accept at 25 s, answer 75 s later.
    const r = await createRequest(stage.admin, { handle: "sim-ep-5c07", intent: "judgment", bid_minor: 2600, expires_in: 5 * 24 * 3600 });
    const before = Date.now();
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    assert.equal(await statusOf(stage.admin, r.id), "accepted");
    const queued = await jobsFor(stage.admin, "simulate", r.id);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0]!.data, { request_id: r.id, step: "answer" });
    const after = (queued[0]!.start_after.getTime() - before) / 1000;
    assert.ok(after >= 74 && after <= 77, `answer after ${after}s`);
    await runSimulateStep(ctx(), { request_id: r.id, step: "answer" });
    assert.equal(await statusOf(stage.admin, r.id), "answered");
  });

  test("Scenario: Silent until expiry", async () => {
    // sim-hb-1f7d is silent; organisations only (the development principal is one).
    const r = await createRequest(stage.admin, { handle: "sim-hb-1f7d", intent: "judgment", bid_minor: 4400, expires_in: 90 });
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    assert.equal(await statusOf(stage.admin, r.id), "sent", "the silent persona never responds");
    await expireDue({ ...ctx(), now: () => new Date(Date.now() + 91_000) });
    assert.equal(await statusOf(stage.admin, r.id), "expired");
  });

  test("Scenario: Verifies like a real answer", async () => {
    const r = await createRequest(stage.admin, { handle: "sim-ol-6a23", intent: "judgment", bid_minor: 4000 });
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    const env = await storedEnvelope(r.id);
    // Recompute the canonical payload from the stored fields and verify with the key named by key_id.
    const { rows } = await stage.admin.query(`SELECT public_key, status FROM signing_keys WHERE key_id = $1`, [env.key_id]);
    assert.equal(rows[0].status, "active");
    const publicKey = await importPublicKey(new Uint8Array(Buffer.from(rows[0].public_key as string, "base64")));
    assert.equal(await verifyAnswer(env, publicKey), true);
    assert.equal(await verifyAnswer({ ...env, confidence: env.confidence === 5 ? 4 : 5 }, publicKey), false, "and it is the signature that holds");
  });

  test("Scenario: Marked in discovery and in answers (worker side: the answer's participant is a marked simulated one)", async () => {
    const r = await createRequest(stage.admin, { handle: "sim-jw-9e48", intent: "observation", bid_minor: 1600 });
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    const { rows } = await stage.admin.query(
      `SELECT p.handle, p.display_label, p.simulated, a.body FROM answers a JOIN participants p ON p.id = a.participant_id WHERE a.request_id = $1`,
      [r.id],
    );
    assert.equal(rows[0].simulated, true);
    assert.match(rows[0].handle as string, /^sim-/);
    assert.match(rows[0].display_label as string, /\(simulated\)$/);
    assert.match(JSON.stringify(rows[0].body), /\(simulated\)/);
  });

  test("every intent a simulated participant accepts is answered with a body its intent accepts", async () => {
    const cases: [string, Intent, number][] = [
      ["sim-jw-9e48", "opinion", 800],
      ["sim-ol-6a23", "action", 7600],
      ["sim-th-2a91", "estimate", 2600], // prompt (the simulator answers what was delivered)
      ["sim-ns-0d39", "observation", 1300],
      ["sim-dm-7b80", "referral", 700],
    ];
    for (const [handle, intent, bid] of cases) {
      const r = await createRequest(stage.admin, {
        handle,
        intent,
        bid_minor: bid,
        expires_in: 3 * 24 * 3600,
        ...(intent === "opinion" ? { options: [{ id: "a", label: "First" }, { id: "b", label: "Second" }] } : {}),
      });
      await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
      const status = await statusOf(stage.admin, r.id);
      if (handle === "sim-dm-7b80") {
        assert.equal(status, "declined", "sim-dm-7b80 is a declining persona");
        continue;
      }
      assert.equal(status, "answered", `${handle} ${intent}`);
      assert.ok(answerEnvelopeSchemaFor(intent).safeParse(await storedEnvelope(r.id)).success, intent);
    }
  });

  test("a retried step changes nothing more; a request past its expiry or no longer open is left alone", async () => {
    const r = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500 });
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    const events = await eventsOf(stage.admin, r.id);
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    assert.deepEqual(await eventsOf(stage.admin, r.id), events);
    assert.equal(await answerCount(stage.admin, r.id), 1);

    const late = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500, expires_in: 1 });
    clock = () => new Date(Date.now() + 5000);
    try {
      await runSimulateStep(ctx(), { request_id: late.id, step: "act" });
    } finally {
      clock = () => new Date();
    }
    assert.equal(await statusOf(stage.admin, late.id), "sent", "left for the expiry job");
    await runSimulateStep(ctx(), { request_id: "A2H-fffd", step: "act" });
  });

  test("simulation logs carry ids, states and codes, never the question or the answer", async () => {
    logs = [];
    const r = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500, question: "Is the dosage table on page two alarming?" });
    await runSimulateStep(ctx(), { request_id: r.id, step: "act" });
    const all = JSON.stringify(logs);
    assert.ok(logs.length > 0);
    for (const leaked of ["dosage", "simulated)", "Margaret", "verdict", key.public_key]) assert.ok(!all.includes(leaked), leaked);
  });
});
