// A pg-boss instance on the test stage's jobs schema, with the worker's
// queues, for tests that call handlers directly and inspect what they enqueue.
import { PgBoss } from "pg-boss";
import type pg from "pg";
import { bossOptions } from "../../src/worker.ts";
import { createQueues, jobsOf, type Jobs } from "../../src/queues.ts";
import { JOBS_SCHEMA, type StageDb } from "./stage-db.ts";

export async function startBoss(stage: StageDb): Promise<{ boss: PgBoss; jobs: Jobs; stop: () => Promise<void> }> {
  const boss = new PgBoss({ ...bossOptions(stage.db), supervise: false, schedule: false });
  boss.on("error", () => undefined);
  await boss.start();
  await createQueues(boss, { simulatorEnabled: true });
  return { boss, jobs: jobsOf(boss), stop: () => boss.stop({ graceful: false }) };
}

export interface QueuedJob {
  name: string;
  data: Record<string, unknown>;
  start_after: Date;
  created_on: Date;
  singleton_key: string | null;
}

/** Jobs of `queue` about `requestId`, as pg-boss stored them. */
export async function jobsFor(admin: pg.Client, queue: string, requestId: string): Promise<QueuedJob[]> {
  const { rows } = await admin.query(
    `SELECT name, data, start_after, created_on, singleton_key FROM ${JOBS_SCHEMA}.job WHERE name = $1 AND data->>'request_id' = $2 ORDER BY created_on`,
    [queue, requestId],
  );
  return rows as QueuedJob[];
}
