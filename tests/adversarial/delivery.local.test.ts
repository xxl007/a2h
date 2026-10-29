// platform/participant-simulation "Only simulated participants are delivered",
// in-process: no deployed stage holds a participant that is not simulated, so
// this is driven against the worker's dispatcher, delivery and expiry on
// Postgres 17 in Docker (apps/worker/test/lib/stage-db.ts, set up as a
// preview). In this change nothing reaches a real person: a due request to a
// participant that is not simulated is never delivered and stays `sent` until
// it expires (real delivery arrives with M3). Synthetic data only.
// Skipped without Docker unless A2H_DB_PG_REQUIRED=1 (set in CI's `pnpm test`).
// Run: pnpm --filter @a2h/tests test
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { createPool } from "../../apps/worker/src/db.ts";
import { deliverRequest, dispatchDue } from "../../apps/worker/src/deliver.ts";
import { expireDue } from "../../apps/worker/src/expire.ts";
import type { WorkerLogLine } from "../../apps/worker/src/log.ts";
import type { Jobs } from "../../apps/worker/src/queues.ts";
import { jobsFor, startBoss } from "../../apps/worker/test/lib/boss.ts";
import { createRequest, statusOf } from "../../apps/worker/test/lib/requests.ts";
import { rows, skipWithoutDocker, startStageDb, testConfig, type StageDb } from "../../apps/worker/test/lib/stage-db.ts";

const REAL = { id: "p_qa_real_0001", handle: "qa-real-0a1b", label: "Q. A. Synthetic" };

describe("only simulated participants are delivered (in-process, Postgres in Docker)", { skip: skipWithoutDocker() }, () => {
  let stage: StageDb;
  let pool: pg.Pool;
  let jobs: Jobs;
  let stopBoss: () => Promise<void>;
  let clock = () => new Date();
  const ctx = () => ({ pool, config: testConfig(stage.db), log: (line: WorkerLogLine) => void line, now: () => clock(), jobs });

  before(async () => {
    stage = await startStageDb();
    pool = createPool(stage.db);
    ({ jobs, stop: stopBoss } = await startBoss(stage));
    await stage.admin.query(`INSERT INTO participants (id, handle, display_label, simulated, persona, identity_verified) VALUES ($1, $2, $3, false, NULL, true)`, [
      REAL.id,
      REAL.handle,
      REAL.label,
    ]);
  });
  after(async () => {
    await stopBoss?.();
    await pool?.end();
    await stage?.stop();
  });

  test("Scenario: Only simulated participants are delivered", async () => {
    const r = await createRequest(stage.admin, { handle: REAL.handle, intent: "judgment", bid_minor: 3500, expires_in: 600 });
    const control = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500 });

    await dispatchDue(ctx());
    await dispatchDue(ctx());
    assert.equal((await jobsFor(stage.admin, "deliver", control.id)).length, 1, "control: a due request to a simulated participant is dispatched");
    assert.deepEqual(await jobsFor(stage.admin, "deliver", r.id), [], "a request to a participant that is not simulated is never dispatched");

    // Even a deliver job forged for it delivers nothing.
    try {
      await deliverRequest(ctx(), r.id);
    } catch {
      /* refusing loudly is fine too: nothing may be delivered */
    }
    assert.deepEqual(await jobsFor(stage.admin, "simulate", r.id), [], "no persona acts for it");
    const delivered = await rows<{ outcome: string }>(stage.admin, `SELECT outcome FROM request_deliveries WHERE request_id = $1`, [r.id]);
    assert.ok(!delivered.some((d) => d.outcome === "delivered"), `delivery rows: ${JSON.stringify(delivered)}`);
    assert.equal(await statusOf(stage.admin, r.id), "sent", "it stays sent");

    // ... until it expires.
    clock = () => new Date(Date.now() + 601_000);
    await expireDue(ctx());
    assert.equal(await statusOf(stage.admin, r.id), "expired");
  });
});
