// The heartbeat worker against a real Postgres 17 in Docker, with the same
// grants a preview stage gets from .github/scripts/pr-schema.sh: login pr_12
// owns schema pr_12 and has no CREATE on the database. Skipped, with a note,
// when Docker is not available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { bossOptions, startWorker, type WorkerLogLine } from "../src/worker.ts";
import type { DbConfig } from "../src/db-config.ts";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const SKIP = dockerAvailable()
  ? false
  : "Docker is not available: the pg-boss integration test needs `docker run postgres:17`";

const SUPERUSER_PASSWORD = "test-superuser";
const ROLE_PASSWORD = "test-pr-12-password";
let container = "";
let port = "";

function psql(sql: string, user = "postgres"): string {
  return execFileSync(
    "docker",
    ["exec", "-e", `PGPASSWORD=${user === "postgres" ? SUPERUSER_PASSWORD : ROLE_PASSWORD}`, container,
      "psql", "-h", "127.0.0.1", "-U", user, "-d", "a2h", "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

before(async () => {
  if (SKIP) return;
  container = execFileSync(
    "docker",
    ["run", "-d", "--rm", "-e", `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`, "-e", "POSTGRES_DB=a2h",
      "-p", "127.0.0.1::5432", "postgres:17"],
    { encoding: "utf8" },
  ).trim();
  port = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" })
    .trim()
    .split(":")
    .pop()!;
  for (let i = 0; i < 120; i++) {
    try {
      psql("select 1");
      break;
    } catch {
      await sleep(500);
    }
  }
  // As pr-schema.sh create does for a preview stage.
  psql(`CREATE ROLE pr_12 WITH LOGIN PASSWORD '${ROLE_PASSWORD}'`);
  psql("CREATE SCHEMA pr_12 AUTHORIZATION pr_12");
  psql("REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC");
  psql("REVOKE CREATE ON DATABASE a2h FROM PUBLIC");
  psql("ALTER ROLE pr_12 SET search_path = pr_12");
});

after(() => {
  if (container) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
});

test("boss options: no schema creation, connection timeout tolerates an Aurora resume", () => {
  const db: DbConfig = { connectionString: "postgres://u:p@h:5432/d", schema: "pr_12", ssl: false };
  const options = bossOptions(db);
  assert.equal(options.schema, "pr_12");
  assert.equal(options.connectionString, db.connectionString);
  assert.equal(options.ssl, false);
  // The schema is provisioned (public, or pr_<n> by pr-schema.sh); the
  // preview login has no CREATE on the database.
  assert.equal(options.createSchema, false);
  assert.equal(options.migrate, true);
  // Aurora Serverless v2 at 0 ACU takes ~15 s to resume.
  assert.ok((options.connectionTimeoutMillis ?? 0) >= 60_000);
});

test("heartbeat: one job is enqueued and processed in schema DB_SCHEMA", { skip: SKIP }, async () => {
  const logs: WorkerLogLine[] = [];
  const db: DbConfig = {
    connectionString: `postgres://pr_12:${encodeURIComponent(ROLE_PASSWORD)}@127.0.0.1:${port}/a2h`,
    schema: "pr_12",
    ssl: false,
  };
  const worker = await startWorker({ db, stage: "pr-12", log: (l) => logs.push(l) });
  try {
    let processed: WorkerLogLine | undefined;
    for (let i = 0; i < 100 && !processed; i++) {
      processed = logs.find((l) => l.msg === "heartbeat job processed");
      if (!processed) await sleep(100);
    }
    assert.ok(processed, `no job processed; logs: ${JSON.stringify(logs)}`);
    assert.equal(processed.stage, "pr-12");
    assert.equal(processed.queue, "heartbeat");
    assert.equal(typeof processed.job_id, "string");
    // pg-boss tables live in pr_12 and nowhere else.
    assert.equal(psql("select count(*) from pg_tables where schemaname = 'pr_12' and tablename = 'job'"), "1");
    assert.equal(psql("select count(*) from pg_tables where schemaname = 'public'"), "0");
    assert.equal(psql("select count(*) from pg_namespace where nspname = 'pgboss'"), "0");
    // Exactly one heartbeat job, and it completed.
    let state = "";
    for (let i = 0; i < 50 && state !== "completed"; i++) {
      state = psql("select string_agg(state::text, ',') from pr_12.job where name = 'heartbeat'");
      if (state !== "completed") await sleep(100);
    }
    assert.equal(state, "completed");
    for (const line of logs) assert.ok(!JSON.stringify(line).includes(ROLE_PASSWORD));
  } finally {
    await worker.stop();
  }
  assert.ok(logs.some((l) => l.msg === "worker stopped"));
});
