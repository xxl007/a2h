// Entry point of the A2H worker (ECS Fargate). Configuration comes from the
// environment through the deployment adapter (infra/env.ts).
import { workerConfigFromEnv } from "../infra/env.ts";
import { startWorker, type WorkerLogLine } from "./worker.ts";

const stage = process.env.STAGE || "local";
const log = (line: WorkerLogLine) => console.log(JSON.stringify({ stage, ...line }));

let stopping = false;

async function main() {
  const worker = await startWorker({ config: workerConfigFromEnv(), log });
  log({ level: "info", msg: "worker started" });

  // ECS sends SIGTERM and kills the task 30 s later; stop() waits up to 20 s
  // for an active job.
  process.on("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    worker.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log({ level: "error", msg: "stop failed", error: error instanceof Error ? error.name : "unknown" });
        process.exit(1);
      },
    );
  });
}

main().catch((error: unknown) => {
  log({
    level: "error",
    msg: "worker failed to start",
    error: error instanceof Error ? error.name : "unknown",
    detail: error instanceof Error ? error.message : undefined,
  });
  process.exit(1);
});
