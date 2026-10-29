// The worker's pg-boss queues (design D8) and how handlers enqueue onto them.
// Job data carries ids only: never a question, an answer or a name.
import type { PgBoss } from "pg-boss";
import type pg from "pg";

export const QUEUES = {
  /** M0: one job at start, visible in the logs. */
  heartbeat: "heartbeat",
  /** Re-validate a due request against the participant's current rules (task 5.2). */
  deliver: "deliver",
  /** Play the simulated participant's persona (task 5.3). Never registered on prod. */
  simulate: "simulate",
  /** Scheduled every minute: sent/accepted past expiry → expired (task 5.4). */
  expire: "expire",
} as const;

export interface DeliverJob {
  request_id: string;
}

export interface SimulateJob {
  request_id: string;
  /** `act`: the persona's first move; `answer`: the slow persona's later answer. */
  step: "act" | "answer";
}

/** Every minute (pg-boss cron). */
export const EXPIRE_CRON = "* * * * *";

export interface Jobs {
  /** One deliver job per request at a time (`exclusive` queue, keyed by request id). */
  deliver(requestId: string): Promise<void>;
  /** Enqueued inside the caller's transaction: it exists only if the delivery committed. */
  simulate(client: pg.PoolClient, job: SimulateJob, startAfterSeconds: number): Promise<void>;
}

export async function createQueues(boss: PgBoss, { simulatorEnabled }: { simulatorEnabled: boolean }): Promise<void> {
  await boss.createQueue(QUEUES.heartbeat);
  await boss.createQueue(QUEUES.expire, { policy: "singleton", retryLimit: 3, retryDelay: 10 });
  if (!simulatorEnabled) return;
  await boss.createQueue(QUEUES.deliver, { policy: "exclusive", retryLimit: 3, retryDelay: 5 });
  await boss.createQueue(QUEUES.simulate, { retryLimit: 3, retryDelay: 5 });
}

export function jobsOf(boss: PgBoss): Jobs {
  return {
    async deliver(requestId) {
      await boss.send(QUEUES.deliver, { request_id: requestId } satisfies DeliverJob, { singletonKey: requestId });
    },
    async simulate(client, job, startAfterSeconds) {
      await boss.send(QUEUES.simulate, { ...job } satisfies SimulateJob, {
        startAfter: startAfterSeconds,
        singletonKey: `${job.request_id}:${job.step}`,
        db: { executeSql: (text, values) => client.query(text, values) },
      });
    },
  };
}
