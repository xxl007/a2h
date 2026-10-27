// The pg-boss worker. M0: one `heartbeat` queue, one job sent at start, so
// the owner sees a job run in the preview logs (m0-foundation proposal, "How
// the product owner validates", item 4).
import { PgBoss, type ConstructorOptions, type Job } from "pg-boss";
import type { DbConfig } from "./db-config.ts";

export type WorkerLogLine = Record<string, string | number | boolean | undefined>;

export const HEARTBEAT_QUEUE = "heartbeat";

interface HeartbeatData {
  stage: string;
}

/** pg-boss constructor options for a DbConfig. Pure. */
export function bossOptions(db: DbConfig): ConstructorOptions {
  return {
    connectionString: db.connectionString,
    schema: db.schema,
    ssl: db.ssl,
    // Create and migrate pg-boss tables inside the stage schema on start().
    migrate: true,
    // The schema already exists (`public`, or `pr_<n>` from pr-schema.sh) and
    // a preview login has no CREATE on the database, so never CREATE SCHEMA.
    createSchema: false,
    // Aurora Serverless v2 pauses at 0 ACU; the first connection can take
    // ~15 s while it resumes. pg-boss's default (10 s) would fail it.
    connectionTimeoutMillis: 60_000,
  };
}

export interface WorkerOptions {
  db: DbConfig;
  stage: string;
  log: (line: WorkerLogLine) => void;
}

export interface RunningWorker {
  /** Graceful: lets the active job finish (up to 20 s), then closes the pool. */
  stop: () => Promise<void>;
}

export async function startWorker({ db, stage, log }: WorkerOptions): Promise<RunningWorker> {
  const boss = new PgBoss(bossOptions(db));
  // Never log the error object itself: keep to name and message.
  boss.on("error", (error: Error) =>
    log({ level: "error", msg: "pg-boss error", error: error.name, detail: error.message }),
  );

  await boss.start();
  await boss.createQueue(HEARTBEAT_QUEUE);
  await boss.work<HeartbeatData>(HEARTBEAT_QUEUE, async (jobs: Job<HeartbeatData>[]) => {
    for (const job of jobs) {
      log({
        level: "info",
        msg: "heartbeat job processed",
        queue: job.name,
        job_id: job.id,
        stage,
        sent_by_stage: job.data.stage,
      });
    }
    return Promise.resolve();
  });
  const jobId = await boss.send(HEARTBEAT_QUEUE, { stage } satisfies HeartbeatData);
  log({ level: "info", msg: "heartbeat job sent", queue: HEARTBEAT_QUEUE, job_id: jobId ?? undefined, stage });

  return {
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 20_000 });
      log({ level: "info", msg: "worker stopped", stage });
    },
  };
}
