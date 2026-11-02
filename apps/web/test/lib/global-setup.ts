// vitest globalSetup: one PostgreSQL container for the whole run, its admin
// URL provided to the test files as `pgAdminUrl` (empty when Docker is not
// available and A2H_DB_PG_REQUIRED is not 1: the database tests then skip).
import type { TestProject } from "vitest/node";
import { dockerAvailable, startPostgres, type PgContainer } from "./postgres";

let container: PgContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  if (!dockerAvailable()) {
    if (process.env["A2H_DB_PG_REQUIRED"] === "1") throw new Error("docker is not available and A2H_DB_PG_REQUIRED=1");
    project.provide("pgAdminUrl", "");
    return;
  }
  container = await startPostgres();
  project.provide("pgAdminUrl", container.url);
}

export function teardown(): void {
  container?.stop();
}

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}
