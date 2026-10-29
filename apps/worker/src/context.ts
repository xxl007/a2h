// What every job handler gets: the stage's pool, the configuration, the log
// and the clock (passed in, so tests can move time).
import type pg from "pg";
import type { WorkerConfig } from "./config.ts";
import type { Log } from "./log.ts";

export interface JobContext {
  pool: pg.Pool;
  config: WorkerConfig;
  log: Log;
  now: () => Date;
}
