// A throwaway PostgreSQL 17 in Docker for the web tests that need a database
// (the auth server, the packages/db queries on the web side). One container
// per test run (vitest globalSetup, test/lib/global-setup.ts); each test file
// gets its own schema and login role, set up the way a preview's is
// (.github/scripts/pr-schema.sh): role `<schema>` with
// `ALTER ROLE … SET search_path = <schema>`, so the schema is chosen by the
// login and no statement names it (the Data API path, design D2).
// Without Docker the tests are skipped, unless A2H_DB_PG_REQUIRED=1.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = new URL("../../../../packages/db/migrations/", import.meta.url).pathname;

export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface PgContainer {
  url: string;
  stop(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function canConnect(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    await c.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

export async function startPostgres(): Promise<PgContainer> {
  const name = `a2h-web-test-${process.pid}-${Date.now()}`;
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", name,
    "-e", "POSTGRES_PASSWORD=postgres",
    "-p", "127.0.0.1::5432",
    process.env["A2H_DB_PG_IMAGE"] ?? "postgres:17",
  ], { stdio: "ignore" });
  const stop = () => {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  };
  try {
    const port = execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).trim().split("\n")[0]!.split(":").pop();
    const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    for (let i = 0; i < 120; i++) {
      if ((await canConnect(url)) && (await sleep(300), await canConnect(url))) return { url, stop };
      await sleep(500);
    }
    throw new Error("postgres did not become ready");
  } catch (e) {
    stop();
    throw e;
  }
}

function statementsOf(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Creates schema and login `name` like pr-schema.sh, applies every migration
 * into it as db-migrate.sh does, and returns the login's connection string.
 */
export async function createStageSchema(adminUrl: string, name: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("bad schema name");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${name} WITH LOGIN PASSWORD '${name}'`);
    await admin.query(`CREATE SCHEMA ${name} AUTHORIZATION ${name}`);
    await admin.query(`ALTER ROLE ${name} SET search_path = ${name}`);
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
      await admin.query("BEGIN");
      try {
        await admin.query(`SET LOCAL ROLE ${name}`);
        await admin.query(`SET LOCAL search_path = ${name}`);
        for (const stmt of statementsOf(join(MIGRATIONS_DIR, file))) await admin.query(stmt);
        await admin.query("COMMIT");
      } catch (e) {
        await admin.query("ROLLBACK");
        throw new Error(`${file}: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.username = name;
  url.password = name;
  return url.toString();
}
