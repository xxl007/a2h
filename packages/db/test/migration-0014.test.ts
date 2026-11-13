// m2-org-sign-in task 3.2 (design "Migration Plan": no backfill) against
// PostgreSQL 17 in Docker: accounts and principals that exist before the
// migration keep access, are not administrators, stay outside the renewal
// window (null `last_idp_sign_in_at`, design D6) and keep their verification.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, migrate, skipWithoutDocker, startPostgres, type PgContainer } from "./lib/postgres.ts";

const skip = skipWithoutDocker();
const SCHEMA = "pr_m14";
const MIGRATION = "0014_org_sign_in.sql";

let pgc: PgContainer;
let client: pg.Client;

describe("migration 0014: existing accounts and principals (Postgres 17)", { skip }, () => {
  before(async () => {
    pgc = await startPostgres();
    client = new pg.Client({ connectionString: pgc.url });
    await client.connect();
    await migrate(client, SCHEMA, (f) => f < MIGRATION);
    await client.query(`SET search_path = ${SCHEMA}`);
    await client.query(`INSERT INTO "user" (id, name, email) VALUES ('u_before', 'a', 'a@a2h.test')`);
    await client.query(`INSERT INTO principals (principal_id, verified, verification_method) VALUES ('u_before', true, 'owner_allowlist'), ('u_no_method', false, NULL)`);
    await client.query(`RESET search_path`);
    await migrate(client, SCHEMA, (f) => f >= MIGRATION);
    await client.query(`SET search_path = ${SCHEMA}`);
  });
  after(async () => {
    await client?.end().catch(() => undefined);
    pgc?.stop();
  });

  test("the migration is the last one and applies on top of existing rows", () => {
    assert.ok(existsSync(join(MIGRATIONS_DIR, MIGRATION)), MIGRATION);
  });
  test("an existing account has access, is not an administrator and has no provider sign-in time", async () => {
    const { rows } = await client.query(`SELECT access_removed_at, is_administrator, last_idp_sign_in_at FROM "user" WHERE id = 'u_before'`);
    assert.deepEqual(rows, [{ access_removed_at: null, is_administrator: false, last_idp_sign_in_at: null }]);
  });
  test("existing principals keep their verification as stored", async () => {
    const { rows } = await client.query(`SELECT principal_id, verified, verification_method FROM principals ORDER BY principal_id`);
    assert.deepEqual(rows, [
      { principal_id: "u_before", verified: true, verification_method: "owner_allowlist" },
      { principal_id: "u_no_method", verified: false, verification_method: null },
    ]);
  });
  test("the record of administrator actions starts empty", async () => {
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM administrator_actions`);
    assert.equal(rows[0]?.n, 0);
  });
});
