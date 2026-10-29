// A preview-like stage database for the worker's tests: PostgreSQL 17 in
// Docker (packages/db's helper), a login `pr_12` that owns `pr_12` (the
// Drizzle tables) and `pr_12_jobs` (pg-boss) and has no CREATE on the
// database, as .github/scripts/pr-schema.sh sets a preview up; the migrations
// applied as that login (db-migrate.sh does `SET ROLE pr_<n>`) and the
// simulated set seeded with `a2h.stage` = `pr-12`. Skipped without Docker
// unless A2H_DB_PG_REQUIRED=1.
import pg from "pg";
import { generateKeyPairSync } from "node:crypto";
import { migrate, skipWithoutDocker, startPostgres, statementsOf, type PgContainer } from "../../../../packages/db/test/lib/postgres.ts";
import { SEED_SQL_PATH } from "../../../../packages/db/seed/sql.ts";
import type { WorkerConfig } from "../../src/config.ts";
import type { DbConfig } from "../../src/db-config.ts";

export { skipWithoutDocker };

export const SCHEMA = "pr_12";
export const JOBS_SCHEMA = "pr_12_jobs";
export const STAGE = "pr-12";
export const PRINCIPAL_ID = "dev-principal-pr-12";
const LOGIN_PASSWORD = "test-only-pr-12";

export interface StageDb {
  /** Superuser connection with search_path = pr_12, for arranging and asserting. */
  admin: pg.Client;
  /** How the worker reaches the stage: as login pr_12, without TLS. */
  db: DbConfig;
  stop(): Promise<void>;
}

export async function startStageDb(): Promise<StageDb> {
  const pgc: PgContainer = await startPostgres();
  const admin = new pg.Client({ connectionString: pgc.url });
  try {
    await admin.connect();
    await admin.query(`CREATE ROLE pr_12 WITH LOGIN PASSWORD '${LOGIN_PASSWORD}'`);
    await admin.query(`CREATE SCHEMA ${SCHEMA} AUTHORIZATION pr_12`);
    await admin.query(`CREATE SCHEMA ${JOBS_SCHEMA} AUTHORIZATION pr_12`);
    // As db-migrate.sh does on a preview: every object is the login's. The
    // helper's migrate() says CREATE SCHEMA IF NOT EXISTS, which needs CREATE
    // on the database even when the schema exists: granted for the migration
    // only, so the login ends with none, as on a preview.
    await admin.query("GRANT CREATE ON DATABASE postgres TO pr_12");
    await admin.query("SET ROLE pr_12");
    await migrate(admin, SCHEMA);
    await admin.query("BEGIN");
    await admin.query(`SET LOCAL search_path = ${SCHEMA}`);
    await admin.query(`SELECT set_config('a2h.stage', $1, true)`, [STAGE]);
    for (const s of statementsOf(SEED_SQL_PATH)) await admin.query(s);
    await admin.query("COMMIT");
    await admin.query("RESET ROLE");
    await admin.query("REVOKE CREATE ON DATABASE postgres FROM pr_12");
    await admin.query("REVOKE CREATE ON DATABASE postgres FROM PUBLIC");
    await admin.query("REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC");
    await admin.query(`SET search_path = ${SCHEMA}`);
  } catch (e) {
    await admin.end().catch(() => undefined);
    pgc.stop();
    throw e;
  }
  const url = new URL(pgc.url);
  url.username = "pr_12";
  url.password = LOGIN_PASSWORD;
  return {
    admin,
    db: { connectionString: url.toString(), schema: SCHEMA, jobsSchema: JOBS_SCHEMA, ssl: false },
    stop: async () => {
      await admin.end().catch(() => undefined);
      pgc.stop();
    },
  };
}

/** A fresh Ed25519 key pair in the form the worker receives (a2h/<stage>/signing). */
export function testSigningKey(key_id: string): WorkerConfig["signing"] {
  const pair = generateKeyPairSync("ed25519");
  return {
    key_id,
    private_key_pkcs8: new Uint8Array(pair.privateKey.export({ format: "der", type: "pkcs8" })),
    public_key: pair.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"),
  };
}

/** The worker configuration of stage pr-12 (the values infra/config.ts gives every stage). */
export function testConfig(db: DbConfig, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    stage: STAGE,
    db,
    simulatorEnabled: true,
    principal: { principal_id: PRINCIPAL_ID, identity_mode: "verified_organisation", verified: true },
    policy: {
      fee_rate: 0.2,
      currency: "EUR",
      monthly_budget_minor: 50_000,
      per_request_cap_minor: 6_000,
      ask_first_above_minor: null,
      daily_request_limit: 50,
      throttled_daily_limit: 5,
    },
    clearingShare: 0.5,
    signing: testSigningKey("a2h-pr-12-0000000000000001"),
    ...overrides,
  };
}

/** Typed rows of a query on the arranging connection. */
export async function rows<T extends object>(client: pg.Client, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query<T & pg.QueryResultRow>(text, params)).rows;
}
