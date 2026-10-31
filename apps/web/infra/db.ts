// Deployment adapter (design D2): the web Lambda reaches Aurora through the
// RDS Data API, authorised by its role on the cluster ARN and the stage's
// database secret; no password in its environment, no VPC. One of the two
// places in apps/web that import an AWS SDK (apps/web/infra; a test keeps
// app/ and src/ free of them).
//
// Schema: the stage's tables carry no schema name (packages/db); the login
// chooses it. Previews use their own login `pr_<n>` (secret a2h/pr-<n>/db),
// whose `search_path` is `pr_<n>` (ALTER ROLE in pr-schema.sh); dev uses the
// master user, whose search_path resolves to `public`. The Data API has no
// session to `SET search_path` on, so this is the only way that holds for
// every statement. `checkSchema` proves it once per cold start: the
// database's `current_schema()` must equal DB_SCHEMA, or nothing is served.
//
// Environment: DB_CLUSTER_ARN, DB_SECRET_ARN, DB_NAME, DB_SCHEMA. No error
// message carries a value.
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { sql } from "@a2h/db";
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import type { PrincipalsDb } from "@a2h/db";

type Env = Record<string, string | undefined>;

export interface DataApiConfig {
  clusterArn: string;
  secretArn: string;
  database: string;
  schema: string;
}

const CLUSTER_ARN = /^arn:aws[a-z-]*:rds:[a-z0-9-]+:[0-9]{12}:cluster:[A-Za-z0-9-]+$/;
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function fail(message: string): never {
  throw new Error(`web database configuration: ${message}`);
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") fail(`${name} is not set`);
  return value;
}

export function dataApiConfigFromEnv(env: Env = process.env): DataApiConfig {
  const clusterArn = required(env, "DB_CLUSTER_ARN");
  const secretArn = required(env, "DB_SECRET_ARN");
  const database = required(env, "DB_NAME");
  const schema = required(env, "DB_SCHEMA");
  if (!CLUSTER_ARN.test(clusterArn)) fail("DB_CLUSTER_ARN is not an RDS cluster ARN");
  if (!SECRET_ARN.test(secretArn)) fail("DB_SECRET_ARN is not a Secrets Manager secret ARN");
  if (!DATABASE_NAME.test(database)) fail("DB_NAME is not a plain identifier");
  if (!SCHEMA_NAME.test(schema)) fail("DB_SCHEMA is not a plain lower-case identifier");
  return { clusterArn, secretArn, database, schema };
}

/** A Drizzle database on the Data API; every packages/db query and Better Auth's adapter run on it. */
export function createDataApiDatabase(config: DataApiConfig, client: RDSDataClient = new RDSDataClient({})) {
  return drizzle(client, { database: config.database, resourceArn: config.clusterArn, secretArn: config.secretArn });
}

/**
 * Refuses to serve when the login does not land in the stage's schema
 * (a dev secret on a preview, a missing ALTER ROLE): one statement.
 */
export async function checkSchema(db: PrincipalsDb, expected: string): Promise<void> {
  const rows: unknown = await db.execute(sql`select current_schema() as schema`);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  const actual = (list[0] as { schema?: unknown } | undefined)?.schema;
  if (actual !== expected) fail("the database login does not resolve to DB_SCHEMA");
}

/**
 * The stage's database from the environment: the Data API when
 * DB_CLUSTER_ARN is set (every deployed stage), else DATABASE_URL on
 * node-postgres for a local server (never on prod). The expected schema is
 * DB_SCHEMA (`public` when unset locally).
 */
export async function databaseFromEnv(env: Env = process.env): Promise<{ db: PrincipalsDb; schema: string }> {
  if (env["DB_CLUSTER_ARN"]) {
    const config = dataApiConfigFromEnv(env);
    return { db: createDataApiDatabase(config) as unknown as PrincipalsDb, schema: config.schema };
  }
  const url = env["DATABASE_URL"];
  if (!url) fail("DB_CLUSTER_ARN is not set");
  if (env["STAGE"] === "prod") fail("DATABASE_URL is refused on prod");
  const schema = env["DB_SCHEMA"] || "public";
  if (!SCHEMA_NAME.test(schema)) fail("DB_SCHEMA is not a plain lower-case identifier");
  const { default: pg } = await import("pg");
  const { drizzle: pgDrizzle } = await import("drizzle-orm/node-postgres");
  return { db: pgDrizzle(new pg.Pool({ connectionString: url, max: 5 })) as unknown as PrincipalsDb, schema };
}
