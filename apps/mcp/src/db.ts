// Postgres access for the mcp service (design D2): Drizzle over a `pg` pool.
// The stage's schema is the connection's search_path, so the unqualified
// tables of packages/db resolve to `public` (dev, prod) or `pr_<n>`.
import type { McpDb } from "@a2h/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { DbConfig } from "./config.ts";

/**
 * Pool size per task. Fargate tasks are small and the mcp tools run a few
 * short queries per call; ten connections per task leaves room for several
 * tasks and the worker under Aurora Serverless v2's connection limit.
 */
export const POOL_MAX = 10;

export interface Database {
  db: McpDb;
  close: () => Promise<void>;
}

export function openDatabase(config: DbConfig): Database {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    ssl: config.ssl === false ? false : { ca: config.ssl.ca, rejectUnauthorized: true },
    max: POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // DbConfig.schema is a plain lower-case identifier (infra/env.ts checks it).
    options: `-c search_path=${config.schema}`,
  });
  // An idle client's error (failover, network) must not crash the process;
  // the next query gets a fresh connection. Nothing about it is logged here.
  pool.on("error", () => undefined);
  return { db: drizzle(pool), close: () => pool.end() };
}
