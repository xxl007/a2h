// The pg-boss worker (design D3, D8). pg-boss lives in its own schema
// (DB_JOBS_SCHEMA); the stage's tables are reached through a separate pool.
// Queues:
// - heartbeat (M0): one job sent at start, so a job shows in the logs;
// - expire: scheduled every minute, every stage (task 5.4);
// - deliver and simulate, with an in-process dispatcher that enqueues due
//   deliveries: only where the simulator is enabled, never on prod (tasks
//   5.2, 5.3, 5.6). In this change the simulator is the only delivery
//   channel; real delivery arrives in M3.
import { PgBoss, type ConstructorOptions, type Job } from "pg-boss";
import type { WorkerConfig } from "./config.ts";
import type { DbConfig } from "./db-config.ts";
import { createPool } from "./db.ts";
import { deliverRequest, dispatchDue } from "./deliver.ts";
import { expireDue } from "./expire.ts";
import type { Log } from "./log.ts";
import { FileScanResultSchema } from "@a2h/protocol";
import type { JobContext } from "./context.ts";
import type { FileEventSource } from "./files/events.ts";
import { applyScanResult, checkFile, deleteUnsentFiles, refuseStaleFiles, ScanResultTooEarly, unsentRequestIds, type FilesContext } from "./files/jobs.ts";
import type { FileStore } from "./files/store.ts";
import {
  createFileQueues,
  createQueues,
  EXPIRE_CRON,
  FILES_SWEEP_CRON,
  jobsOf,
  QUEUES,
  type DeliverJob,
  type FileCheckJob,
  type FilesDeleteJob,
  type SimulateJob,
} from "./queues.ts";
import { loadSigner, registerStageKey } from "./signing-keys.ts";
import { runSimulateStep, type SimulateContext } from "./simulate.ts";
import { errorFields } from "./error-log.ts";

export type { WorkerLogLine } from "./log.ts";

export const HEARTBEAT_QUEUE = QUEUES.heartbeat;

interface HeartbeatData {
  stage: string;
}

/** pg-boss constructor options for a DbConfig. Pure. */
export function bossOptions(db: DbConfig): ConstructorOptions {
  return {
    connectionString: db.connectionString,
    schema: db.jobsSchema,
    ssl: db.ssl,
    // Create and migrate pg-boss tables inside the jobs schema on start().
    migrate: true,
    // The schema already exists (`pgboss` from db-migrate.sh, `pr_<n>_jobs`
    // from pr-schema.sh) and a preview login has no CREATE on the database,
    // so never CREATE SCHEMA.
    createSchema: false,
    // Aurora Serverless v2 pauses at 0 ACU; the first connection can take
    // ~15 s while it resumes. pg-boss's default (10 s) would fail it.
    connectionTimeoutMillis: 60_000,
  };
}

/**
 * The worker's file storage and file events (m2-attachments task 3.2): S3 and
 * the stage's SQS queue on a deployed stage (apps/worker/infra), the
 * in-memory pair (src/files/memory.ts) in tests and local runs. Without it
 * the file queues are not created.
 */
export interface WorkerFiles {
  store: FileStore;
  events: FileEventSource;
  /** The stage's STORAGE_PREFIX. */
  storagePrefix: string;
  /** Retry delay of a scan result that overtook the content check (default 10 s). */
  scanRetryDelaySeconds?: number;
}

export interface WorkerOptions {
  config: WorkerConfig;
  log: Log;
  files?: WorkerFiles;
  /** How often the dispatcher looks for due deliveries (default 5 s). */
  dispatchIntervalMs?: number;
  /** pg-boss polling interval of the worker's queues (default 2 s). */
  pollingIntervalSeconds?: number;
}

export interface RunningWorker {
  /** Graceful: lets the active job finish (up to 20 s), then closes the pools. */
  stop: () => Promise<void>;
  /** Enqueue a files-sweep now instead of at the next minute (tests, local runs). */
  runFilesSweep: () => Promise<void>;
}

/** Registers the file queues and starts taking file events (m2-attachments D3, D5). */
async function startFiles(boss: PgBoss, ctx: JobContext, files: WorkerFiles, work: { pollingIntervalSeconds: number }): Promise<void> {
  const { log } = ctx;
  const fctx: FilesContext = { ...ctx, store: files.store, storagePrefix: files.storagePrefix };
  await createFileQueues(boss, files.scanRetryDelaySeconds === undefined ? {} : { scanRetryDelaySeconds: files.scanRetryDelaySeconds });
  await boss.work<FileCheckJob>(QUEUES.fileCheck, work, async (batch) => {
    for (const job of batch) await checkFile(fctx, job.data.file_id);
  });
  await boss.work(QUEUES.fileScan, work, async (batch: Job<unknown>[]) => {
    for (const job of batch) {
      const parsed = FileScanResultSchema.safeParse(job.data);
      if (!parsed.success) {
        log({ level: "error", msg: "file scan job malformed", job_id: job.id });
        continue;
      }
      try {
        await applyScanResult(fctx, parsed.data);
      } catch (error) {
        if (error instanceof ScanResultTooEarly) log({ level: "info", msg: "scan result before the content check, retrying", file_id: parsed.data.file_id });
        throw error;
      }
    }
  });
  await boss.work(QUEUES.filesSweep, work, async () => {
    try {
      await refuseStaleFiles(fctx);
      for (const requestId of await unsentRequestIds(fctx)) {
        await boss.send(QUEUES.filesDelete, { request_id: requestId } satisfies FilesDeleteJob, { singletonKey: requestId });
      }
    } catch (error) {
      log({ level: "error", msg: "files sweep failed", ...errorFields(error) });
      throw error;
    }
  });
  await boss.schedule(QUEUES.filesSweep, FILES_SWEEP_CRON);
  await boss.work<FilesDeleteJob>(QUEUES.filesDelete, work, async (batch) => {
    for (const job of batch) await deleteUnsentFiles(fctx, job.data.request_id);
  });
  files.events.start(async (event) => {
    if (event.kind === "created") await boss.send(QUEUES.fileCheck, { file_id: event.file_id } satisfies FileCheckJob);
    else await boss.send(QUEUES.fileScan, { ...event.result });
  });
  log({ level: "info", msg: "file intake started" });
}

export async function startWorker({ config, log, files, dispatchIntervalMs = 5_000, pollingIntervalSeconds = 2 }: WorkerOptions): Promise<RunningWorker> {
  const { stage } = config;
  const boss = new PgBoss(bossOptions(config.db));
  boss.on("error", (error: Error) => log({ level: "error", msg: "pg-boss error", ...errorFields(error) }));
  const pool = createPool(config.db, (error) => log({ level: "error", msg: "database pool error", ...errorFields(error) }));
  const now = () => new Date();
  const jobs = jobsOf(boss);
  const work = { pollingIntervalSeconds };

  await boss.start();
  await createQueues(boss, { simulatorEnabled: config.simulatorEnabled });

  await boss.work<HeartbeatData>(HEARTBEAT_QUEUE, async (batch: Job<HeartbeatData>[]) => {
    for (const job of batch) {
      log({ level: "info", msg: "heartbeat job processed", queue: job.name, job_id: job.id, stage, sent_by_stage: job.data.stage });
    }
    return Promise.resolve();
  });

  const ctx = { pool, config, log, now, jobs };
  await boss.work(QUEUES.expire, work, async () => {
    try {
      await expireDue(ctx);
    } catch (error) {
      log({ level: "error", msg: "expire failed", ...errorFields(error) });
      throw error;
    }
  });
  await boss.schedule(QUEUES.expire, EXPIRE_CRON);

  if (files) await startFiles(boss, ctx, files, work);
  else log({ level: "info", msg: "file intake disabled", stage });

  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  if (config.simulatorEnabled) {
    // The stage key signs simulated answers only; it is recorded where it is used.
    await registerStageKey(pool, config.signing);
    log({ level: "info", msg: "signing key registered", key_id: config.signing.key_id, stage });
    const simulateCtx: SimulateContext = { ...ctx, signer: { key_id: config.signing.key_id, privateKey: await loadSigner(config.signing) } };

    await boss.work<DeliverJob>(QUEUES.deliver, work, async (batch) => {
      for (const job of batch) await deliverRequest(ctx, job.data.request_id);
    });
    await boss.work<SimulateJob>(QUEUES.simulate, work, async (batch) => {
      for (const job of batch) await runSimulateStep(simulateCtx, job.data);
    });

    let dispatching = false;
    const tick = () => {
      if (dispatching) return;
      dispatching = true;
      inFlight = dispatchDue(ctx)
        .then(() => undefined)
        .catch((error: unknown) => log({ level: "error", msg: "dispatch failed", ...errorFields(error) }))
        .finally(() => {
          dispatching = false;
        });
    };
    timer = setInterval(tick, dispatchIntervalMs);
    tick();
  } else {
    log({ level: "info", msg: "simulator disabled", stage });
  }

  const jobId = await boss.send(HEARTBEAT_QUEUE, { stage } satisfies HeartbeatData);
  log({ level: "info", msg: "heartbeat job sent", queue: HEARTBEAT_QUEUE, job_id: jobId ?? undefined, stage });

  return {
    runFilesSweep: async () => {
      if (!files) throw new Error("file intake is disabled");
      await boss.send(QUEUES.filesSweep, {});
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      // An SQS long poll can take 20 s: stop taking events without waiting for it (an
      // unhandled message stays on the queue), so the 20 s pg-boss drain fits ECS's 30 s.
      if (files) await Promise.race([files.events.stop(), new Promise((r) => setTimeout(r, 2_000).unref())]);
      await inFlight;
      await boss.stop({ graceful: true, timeout: 20_000 });
      await pool.end();
      log({ level: "info", msg: "worker stopped", stage });
    },
  };
}
