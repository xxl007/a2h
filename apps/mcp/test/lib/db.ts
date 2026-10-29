// Database-backed tests: one PostgreSQL 17 container per test file (the
// packages/db Docker helper), a fresh schema per test group with the real
// migrations and the real simulated seed applied, as db-migrate.sh does.
import pg from "pg";
import { SEED_SQL_PATH } from "../../../../packages/db/seed/sql.ts";
import { migrate, skipWithoutDocker, startPostgres, statementsOf, type PgContainer } from "../../../../packages/db/test/lib/postgres.ts";
import type { DbConfig } from "../../src/config.ts";

export { skipWithoutDocker, startPostgres, type PgContainer };

let schemas = 0;

/** A new schema `t<pid>_<n>` with every migration and the simulated set, as on a preview. */
export async function freshSchema(pgc: PgContainer): Promise<DbConfig> {
  const schema = `t${process.pid}_${++schemas}`;
  const client = new pg.Client({ connectionString: pgc.url });
  await client.connect();
  try {
    await migrate(client, schema);
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path = ${schema}`);
    await client.query(`SELECT set_config('a2h.stage', 'test', true)`);
    for (const statement of statementsOf(SEED_SQL_PATH)) await client.query(statement);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
  return { connectionString: pgc.url, schema, ssl: false };
}

/** Run SQL in a schema (test setup and assertions only). */
export async function sqlIn<T extends pg.QueryResultRow = Record<string, unknown>>(
  config: DbConfig,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: config.connectionString });
  await client.connect();
  try {
    await client.query(`SET search_path = ${config.schema}`);
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** Row counts of the tables a tool could write to. */
export async function writeCounts(config: DbConfig): Promise<Record<string, number>> {
  const [row] = await sqlIn<Record<string, number>>(
    config,
    `SELECT (SELECT count(*)::int FROM requests) AS requests,
            (SELECT count(*)::int FROM request_events) AS request_events,
            (SELECT count(*)::int FROM blocked_manifests) AS blocked_manifests,
            (SELECT count(*)::int FROM answers) AS answers`,
  );
  return row!;
}
