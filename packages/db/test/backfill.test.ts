// Migration 0008 against PostgreSQL 17 in Docker: decision 8 applies to the
// principals created by consent before it (m1-hosted-connector task 5.7, PM
// decision 2026-11-02). A principal with a Better Auth user, unverified and
// without a method, is verified by the owner's allow-list; a row without a
// user (the seeded fallback principal) and a row already carrying a method
// are left as they are. Spec platform/principal-identity "Allow-listed
// principals are verified by the owner's allow-list".
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, migrate, skipWithoutDocker, startPostgres, type PgContainer } from "./lib/postgres.ts";

const skip = skipWithoutDocker();
const SCHEMA = "pr_backfill";
const BACKFILL = "0008_principals_owner_allowlist_backfill.sql";

let pgc: PgContainer;
let client: pg.Client;

type Row = { principal_id: string; verified: boolean; verification_method: string | null };

describe("migration 0008: principals created by consent before decision 8 (Postgres 17)", { skip }, () => {
  let rows: Map<string, Row>;

  before(async () => {
    pgc = await startPostgres();
    client = new pg.Client({ connectionString: pgc.url });
    await client.connect();
    await migrate(client, SCHEMA, (f) => f < BACKFILL);
    await client.query(`SET search_path = ${SCHEMA}`);
    await client.query(`INSERT INTO "user" (id, name, email) VALUES
      ('u_consented_before', 'a', 'a.example'), ('u_already_verified', 'b', 'b.example'), ('u_flipped_by_hand', 'c', 'c.example')`);
    await client.query(`INSERT INTO principals (principal_id, verified, verification_method) VALUES
      ('u_consented_before', false, NULL),
      ('u_already_verified', true, 'owner_allowlist'),
      ('u_flipped_by_hand', true, NULL),
      ('dev-principal-pr-backfill', true, NULL),
      ('u_no_user', false, NULL)`);
    await client.query(`RESET search_path`);
    await migrate(client, SCHEMA, (f) => f >= BACKFILL);
    const { rows: got } = await client.query<Row>(`SELECT principal_id, verified, verification_method FROM ${SCHEMA}.principals`);
    rows = new Map(got.map((r) => [r.principal_id, r]));
  });
  after(async () => {
    await client?.end().catch(() => undefined);
    pgc?.stop();
  });

  test("the migration file exists and every row survived it", () => {
    assert.ok(existsSync(join(MIGRATIONS_DIR, BACKFILL)), BACKFILL);
    assert.equal(rows.size, 5);
  });
  test("a principal with a user, unverified and without a method, is verified by the owner's allow-list", () => {
    assert.deepEqual(rows.get("u_consented_before"), { principal_id: "u_consented_before", verified: true, verification_method: "owner_allowlist" });
  });
  test("a row without a Better Auth user is unchanged (the seeded fallback principal; an orphan)", () => {
    assert.deepEqual(rows.get("dev-principal-pr-backfill"), { principal_id: "dev-principal-pr-backfill", verified: true, verification_method: null });
    assert.deepEqual(rows.get("u_no_user"), { principal_id: "u_no_user", verified: false, verification_method: null });
  });
  test("a row already verified is unchanged, with or without a method", () => {
    assert.deepEqual(rows.get("u_already_verified"), { principal_id: "u_already_verified", verified: true, verification_method: "owner_allowlist" });
    assert.deepEqual(rows.get("u_flipped_by_hand"), { principal_id: "u_flipped_by_hand", verified: true, verification_method: null });
  });
});
