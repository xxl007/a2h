// Postgres access for the worker's own tables (design D2): Drizzle over `pg`,
// one pool whose connections see the stage schema (`public` or `pr_<n>`)
// first on their search_path. pg-boss has its own pool in DB_JOBS_SCHEMA.
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@a2h/db";
import type { DbConfig } from "./db-config.ts";

export type Db = NodePgDatabase<typeof schema>;

/** The stage's pool. The schema name was checked by the adapter (plain identifier). */
export function createPool(db: DbConfig, onError: (error: Error) => void = () => undefined): pg.Pool {
  const pool = new pg.Pool({
    connectionString: db.connectionString,
    ssl: db.ssl,
    max: 5,
    // Aurora Serverless v2 at 0 ACU takes ~15 s to resume.
    connectionTimeoutMillis: 60_000,
    options: `-c search_path=${db.schema}`,
  });
  // An idle client's error must not crash the process; the next query fails and is handled.
  pool.on("error", onError);
  return pool;
}

/**
 * Runs `fn` in one Postgres transaction: every write inside commits together
 * or not at all. `client` is the transaction's connection, for the pg-boss
 * calls that must commit with it.
 */
export async function inTransaction<T>(pool: pg.Pool, fn: (tx: Db, client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(drizzle(client, { schema }), client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Drizzle over the pool, for reads and single statements outside a transaction. */
export function dbOf(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
