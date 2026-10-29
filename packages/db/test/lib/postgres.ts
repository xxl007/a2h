// A throwaway PostgreSQL 17 (Aurora's engine version, infra/database.ts) in
// Docker for the package's database tests. Without Docker the tests are
// skipped, unless A2H_DB_PG_REQUIRED=1 (set it in CI), in which case they fail.
// Synthetic, local-only credentials; the server listens on 127.0.0.1 only.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url).pathname;

export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `skip` option for node:test: a reason string when the database tests cannot run. */
export function skipWithoutDocker(): string | false {
  if (dockerAvailable()) return false;
  if (process.env["A2H_DB_PG_REQUIRED"] === "1") throw new Error("docker is not available and A2H_DB_PG_REQUIRED=1");
  return "docker is not available";
}

export interface PgContainer {
  url: string;
  stop(): void;
}

export async function startPostgres(): Promise<PgContainer> {
  const name = `a2h-db-test-${process.pid}-${Math.floor(performance.now())}`;
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", name,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
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
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    for (let i = 0; i < 120; i++) {
      // The image restarts the server once after init; require two good probes in a row.
      if ((await canConnect(url)) && (await sleep(300), await canConnect(url))) return { url, stop };
      await sleep(500);
    }
    throw new Error("postgres did not become ready");
  } catch (e) {
    stop();
    throw e;
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The migration files in apply order (their names sort in journal order). */
export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
}

/** The statements of one migration file, split on drizzle-kit's breakpoint marker. */
export function statementsOf(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Applies every migration in `schema` (created if absent), one transaction per file. */
export async function migrate(client: pg.Client, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  for (const file of migrationFiles()) {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL search_path = ${schema}`);
      for (const stmt of statementsOf(join(MIGRATIONS_DIR, file))) await client.query(stmt);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`${file}: ${(e as Error).message}`, { cause: e });
    }
  }
}
