// Task 5.1 (design D3): pg-boss runs in its own schema, DB_JOBS_SCHEMA, on a
// preview-like database (login pr_12 owns pr_12 and pr_12_jobs, no CREATE on
// the database), and the stage schema keeps only the Drizzle tables. The M0
// heartbeat still runs, now in the jobs schema.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { bossOptions, startWorker, type WorkerLogLine } from "../src/worker.ts";
import type { DbConfig } from "../src/db-config.ts";
import { JOBS_SCHEMA, SCHEMA, rows, skipWithoutDocker, startStageDb, testConfig, type StageDb } from "./lib/stage-db.ts";

const skip = skipWithoutDocker();
let stage: StageDb;

before(async () => {
  if (!skip) stage = await startStageDb();
});
after(async () => {
  await stage?.stop();
});

const DRIZZLE_TABLES = [
  "account", "answers", "blocked_manifests", "jwks", "oauth_access_token", "oauth_client", "oauth_client_assertion",
  "oauth_client_resource", "oauth_consent", "oauth_refresh_token", "oauth_resource", "participants", "principal_policies",
  "principals", "profiles", "rate_limit_windows", "request_deliveries", "request_events", "requests", "rule_types", "rules",
  "schema_migrations", "session", "signing_keys", "simulated_personas", "user", "verification",
];

test("boss options: the jobs schema, no schema creation, connection timeout tolerates an Aurora resume", () => {
  const db: DbConfig = { connectionString: "postgres://u:p@h:5432/d", schema: "pr_12", jobsSchema: "pr_12_jobs", ssl: false };
  const options = bossOptions(db);
  assert.equal(options.schema, "pr_12_jobs", "pg-boss lives in DB_JOBS_SCHEMA, never in the stage's tables");
  assert.equal(options.connectionString, db.connectionString);
  assert.equal(options.ssl, false);
  // The schema is provisioned (pgboss by db-migrate.sh, pr_<n>_jobs by
  // pr-schema.sh); the preview login has no CREATE on the database.
  assert.equal(options.createSchema, false);
  assert.equal(options.migrate, true);
  // Aurora Serverless v2 at 0 ACU takes ~15 s to resume.
  assert.ok((options.connectionTimeoutMillis ?? 0) >= 60_000);
});

test("the worker starts where the jobs schema exists; pg-boss tables are in pr_12_jobs, pr_12 holds only Drizzle tables", { skip }, async () => {
  const logs: WorkerLogLine[] = [];
  const worker = await startWorker({ config: testConfig(stage.db), log: (l) => logs.push(l) });
  try {
    let processed: WorkerLogLine | undefined;
    for (let i = 0; i < 100 && !processed; i++) {
      processed = logs.find((l) => l.msg === "heartbeat job processed");
      if (!processed) await sleep(100);
    }
    assert.ok(processed, `no heartbeat processed; logs: ${JSON.stringify(logs)}`);
    const q = (sql: string, params: unknown[] = []) => rows<{ tablename?: string; nspname?: string }>(stage.admin, sql, params);
    const jobTables = await q(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [JOBS_SCHEMA]);
    assert.ok(jobTables.some((r) => r.tablename === "job"), "pg-boss job table in pr_12_jobs");
    const stageTables = await q(`SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY 1`, [SCHEMA]);
    assert.deepEqual(stageTables.map((r) => r.tablename), DRIZZLE_TABLES);
    assert.deepEqual(await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`), []);
    assert.deepEqual(await q(`SELECT nspname FROM pg_namespace WHERE nspname = 'pgboss'`), [], "no stray pgboss schema");
    for (const line of logs) assert.ok(!JSON.stringify(line).includes("test-only-pr-12"), "password in a log line");
  } finally {
    await worker.stop();
  }
  assert.ok(logs.some((l) => l.msg === "worker stopped"));
});
