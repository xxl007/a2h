// Task 5.2: the `deliver` queue re-runs the participant-rules validation
// against the rules as they are at delivery time (spec request-lifecycle
// "Delivery re-validates the manifest"; protocol skill §5: fails closed).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { createPool } from "../src/db.ts";
import { deliverRequest, dispatchDue } from "../src/deliver.ts";
import { expireDue } from "../src/expire.ts";
import type { WorkerLogLine } from "../src/log.ts";
import type { Jobs } from "../src/queues.ts";
import { jobsFor, startBoss } from "./lib/boss.ts";
import { createRequest, statusOf } from "./lib/requests.ts";
import { PRINCIPAL_ID, rows, skipWithoutDocker, startStageDb, testConfig, type StageDb } from "./lib/stage-db.ts";

const skip = skipWithoutDocker();

describe("deliver", { skip }, () => {
  let stage: StageDb;
  let pool: pg.Pool;
  let jobs: Jobs;
  let stopBoss: () => Promise<void>;
  let logs: WorkerLogLine[] = [];
  let clock = () => new Date();
  const ctx = () => ({ pool, config: testConfig(stage.db), log: (l: WorkerLogLine) => logs.push(l), now: () => clock(), jobs });

  before(async () => {
    stage = await startStageDb();
    pool = createPool(stage.db);
    ({ jobs, stop: stopBoss } = await startBoss(stage));
  });
  after(async () => {
    await stopBoss?.();
    await pool?.end();
    await stage?.stop();
  });

  async function deliveryOf(id: string) {
    return rows<{ outcome: string; participant_id: string }>(stage.admin, `SELECT outcome, participant_id FROM request_deliveries WHERE request_id = $1`, [id]);
  }
  async function blockedOf(id: string) {
    return rows<{ participant_id: string; principal_id: string; stage: string; code: string }>(
      stage.admin,
      `SELECT participant_id, principal_id, stage, code FROM blocked_manifests WHERE request_id = $1`,
      [id],
    );
  }

  test("Scenario: Rules changed after approval", async () => {
    // sim-th-2a91 (prompt): knowledge reserve 4500 net = 5625 gross; the bid of 5700 passed at approval.
    const r = await createRequest(stage.admin, { handle: "sim-th-2a91", intent: "knowledge", bid_minor: 5700, expires_in: 13 * 3600 });
    // Between approval and delivery the participant raises the reserve above the bid.
    await stage.admin.query(`UPDATE rule_types SET reserve_net_minor = 4800 WHERE participant_id = $1 AND intent = 'knowledge'`, [r.participant_id]);
    try {
      logs = [];
      await deliverRequest(ctx(), r.id);
      // Nothing is delivered: no simulated participant is asked anything.
      assert.deepEqual(await jobsFor(stage.admin, "simulate", r.id), []);
      assert.deepEqual(await deliveryOf(r.id), [{ outcome: "blocked", participant_id: r.participant_id }]);
      // A blocked-manifest row is written: ids, stage, code only.
      assert.deepEqual(await blockedOf(r.id), [{ participant_id: r.participant_id, principal_id: PRINCIPAL_ID, stage: "rules", code: "bid_below_reserve" }]);
      assert.equal(await statusOf(stage.admin, r.id), "sent", "the request stays sent");
      const line = logs.find((l) => l.msg === "delivery blocked");
      assert.ok(line, JSON.stringify(logs));
      assert.equal(line.request_id, r.id);
      assert.equal(line.code, "bid_below_reserve");
      assert.ok(!JSON.stringify(logs).includes("leaflet"), "no question text in logs");
      // A second delivery attempt does not deliver it either, nor count it twice.
      await deliverRequest(ctx(), r.id);
      assert.equal((await blockedOf(r.id)).length, 1);
      // ... and the request expires at its expiry time.
      clock = () => new Date(Date.now() + 13 * 3600 * 1000 + 1000);
      await expireDue(ctx());
      assert.equal(await statusOf(stage.admin, r.id), "expired");
    } finally {
      clock = () => new Date();
      await stage.admin.query(`UPDATE rule_types SET reserve_net_minor = 4500 WHERE participant_id = $1 AND intent = 'knowledge'`, [r.participant_id]);
    }
  });

  test("a manifest that still passes is delivered once: one delivery row, one simulate job after the persona's delay", async () => {
    const r = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500 });
    const before = Date.now();
    await deliverRequest(ctx(), r.id);
    await deliverRequest(ctx(), r.id);
    assert.deepEqual(await deliveryOf(r.id), [{ outcome: "delivered", participant_id: r.participant_id }]);
    assert.deepEqual(await blockedOf(r.id), []);
    const queued = await jobsFor(stage.admin, "simulate", r.id);
    assert.equal(queued.length, 1, "delivered once");
    assert.deepEqual(queued[0]!.data, { request_id: r.id, step: "act" });
    // The prompt persona's delay is 20 s (seed).
    const delay = (queued[0]!.start_after.getTime() - before) / 1000;
    assert.ok(delay >= 19 && delay <= 22, `start after ${delay}s`);
    assert.equal(await statusOf(stage.admin, r.id), "sent");
  });

  test("inside the participant's quiet hours the delivery is deferred to the end of them, nothing delivered now", async () => {
    // sim-ep-5c07: quiet 22:00-07:00 Europe/London, latency promise 24 h.
    const r = await createRequest(stage.admin, { handle: "sim-ep-5c07", intent: "judgment", bid_minor: 2600, expires_in: 5 * 24 * 3600 });
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const lateEvening = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 23, 30));
    clock = () => lateEvening;
    try {
      await deliverRequest(ctx(), r.id);
    } finally {
      clock = () => new Date();
    }
    assert.deepEqual(await deliveryOf(r.id), []);
    assert.deepEqual(await jobsFor(stage.admin, "simulate", r.id), []);
    const [row] = await rows<{ deliver_at: Date }>(stage.admin, `SELECT deliver_at FROM requests WHERE id = $1`, [r.id]);
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(row!.deliver_at);
    assert.equal(local, "07:00");
    assert.ok(row!.deliver_at.getTime() > lateEvening.getTime());
  });

  test("interruption budget at delivery: deliveries already made today count, the next one is blocked", async () => {
    // sim-bk-2e6f: at most 2 interruptions a day; knowledge reserve 3000 net = 3750 gross.
    const make = () => createRequest(stage.admin, { handle: "sim-bk-2e6f", intent: "knowledge", bid_minor: 4000, expires_in: 3 * 24 * 3600 });
    const first = await make();
    const second = await make();
    const third = await make();
    await deliverRequest(ctx(), first.id);
    await deliverRequest(ctx(), second.id);
    await deliverRequest(ctx(), third.id);
    assert.equal((await deliveryOf(first.id))[0]?.outcome, "delivered");
    assert.equal((await deliveryOf(second.id))[0]?.outcome, "delivered");
    assert.equal((await deliveryOf(third.id))[0]?.outcome, "blocked");
    assert.equal((await blockedOf(third.id))[0]?.code, "interruption_budget");
  });

  test("a request that is no longer sent, or past its expiry, is not delivered (and not counted)", async () => {
    const accepted = await createRequest(stage.admin, { handle: "sim-ol-6a23", intent: "judgment", bid_minor: 4000, status: "accepted" });
    await deliverRequest(ctx(), accepted.id);
    assert.deepEqual(await deliveryOf(accepted.id), []);
    const late = await createRequest(stage.admin, { handle: "sim-ol-6a23", intent: "judgment", bid_minor: 4000, expires_in: 1 });
    clock = () => new Date(Date.now() + 5000);
    try {
      await deliverRequest(ctx(), late.id);
    } finally {
      clock = () => new Date();
    }
    assert.deepEqual(await deliveryOf(late.id), []);
    assert.deepEqual(await blockedOf(late.id), []);
    await deliverRequest(ctx(), "A2H-fffe"); // unknown: nothing, no throw
  });

  test("a participant whose rules are gone accepts nothing: blocked as type_not_accepted, counted", async () => {
    const r = await createRequest(stage.admin, { handle: "sim-cf-4c5e", intent: "estimate", bid_minor: 2600, expires_in: 3 * 24 * 3600 });
    const [saved] = await rows<Record<string, unknown>>(stage.admin, `SELECT * FROM rules WHERE participant_id = $1`, [r.participant_id]);
    assert.ok(saved);
    await stage.admin.query(`DELETE FROM rules WHERE participant_id = $1`, [r.participant_id]);
    try {
      await deliverRequest(ctx(), r.id);
    } finally {
      const cols = Object.keys(saved);
      await stage.admin.query(`INSERT INTO rules (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => saved[c]));
    }
    assert.equal((await deliveryOf(r.id))[0]?.outcome, "blocked");
    assert.equal((await blockedOf(r.id))[0]?.code, "type_not_accepted");
    assert.deepEqual(await jobsFor(stage.admin, "simulate", r.id), []);
  });

  test("Scenario: Only simulated participants are delivered: a request to a real participant is not delivered and stays sent until it expires", async () => {
    // A participant that is not simulated, with published terms that accept the request.
    await stage.admin.query(`INSERT INTO participants (id, handle, display_label, simulated, persona, identity_verified)
      VALUES ('p_real_ab', 'ab-1a2b', 'Ann Brook', false, NULL, true)`);
    await stage.admin.query(`INSERT INTO profiles (participant_id, topics, rating, typical_latency_seconds)
      VALUES ('p_real_ab', '[{"topic":"leaflets","evidence":"job_title"}]', 4.5, 3600)`);
    await stage.admin.query(`INSERT INTO rules (participant_id, who_may_ask, max_interruptions_per_day, latency_promise_seconds)
      VALUES ('p_real_ab', 'anyone_verified', 10, 3600)`);
    await stage.admin.query(`INSERT INTO rule_types (participant_id, intent, accepted, reserve_net_minor, currency) VALUES ('p_real_ab', 'judgment', true, 1000, 'EUR')`);
    const r = await createRequest(stage.admin, { handle: "ab-1a2b", bid_minor: 3500, expires_in: 2 * 3600 });
    try {
      await dispatchDue(ctx());
      assert.deepEqual(await jobsFor(stage.admin, "deliver", r.id), [], "the dispatcher does not pick it up");
      await deliverRequest(ctx(), r.id); // even if a job for it existed
      assert.deepEqual(await deliveryOf(r.id), [], "no delivery row");
      assert.deepEqual(await blockedOf(r.id), [], "not counted as blocked either");
      assert.deepEqual(await jobsFor(stage.admin, "simulate", r.id), []);
      assert.equal(await statusOf(stage.admin, r.id), "sent");
      clock = () => new Date(Date.now() + 2 * 3600 * 1000 + 1000);
      await expireDue(ctx());
      assert.equal(await statusOf(stage.admin, r.id), "expired", "it stays sent until it expires");
    } finally {
      clock = () => new Date();
    }
  });

  test("dispatch: every due, undelivered request to a simulated participant gets one deliver job; future ones none", async () => {
    const due = await createRequest(stage.admin, { handle: "sim-ag-3b62", intent: "knowledge", bid_minor: 4500 });
    const later = await createRequest(stage.admin, { handle: "sim-ag-3b62", intent: "knowledge", bid_minor: 4500, deliver_in: 3600 });
    await dispatchDue(ctx());
    await dispatchDue(ctx());
    const queued = await jobsFor(stage.admin, "deliver", due.id);
    assert.equal(queued.length, 1, "one deliver job per request, however often dispatch runs");
    assert.deepEqual(queued[0]!.data, { request_id: due.id });
    assert.deepEqual(await jobsFor(stage.admin, "deliver", later.id), []);
  });
});
