// Task 3.2: the simulated set (spec platform/participant-simulation).
// Content checks run without a database; "Redeploy" and the production guard
// run on Postgres 17 in Docker. tests/ci/db-migrate.test.sh checks the same
// through db-migrate.sh.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import * as protocol from "@a2h/protocol";
import { SEED_PERSONAS, SEED_PARTICIPANTS } from "../seed/simulated.ts";
import { SEED_SQL_PATH, seedSql } from "../seed/sql.ts";
import { migrate, skipWithoutDocker, startPostgres, statementsOf, type PgContainer } from "./lib/postgres.ts";

describe("the simulated set", () => {
  test("twelve participants, handles unique", () => {
    assert.equal(SEED_PARTICIPANTS.length, 12);
    assert.equal(new Set(SEED_PARTICIPANTS.map((p) => p.handle)).size, 12);
    assert.equal(new Set(SEED_PARTICIPANTS.map((p) => p.id)).size, 12);
  });

  test("Scenario: Marked in discovery (seed side): sim- handle, label ending (simulated)", () => {
    for (const p of SEED_PARTICIPANTS) {
      assert.ok(protocol.HandleSchema.safeParse(p.handle).success, p.handle);
      assert.ok(p.handle.startsWith(protocol.SIMULATED_HANDLE_PREFIX), p.handle);
      assert.ok(p.display_label.endsWith(` ${protocol.SIMULATED_LABEL_SUFFIX}`), p.display_label);
      assert.ok(protocol.OpaqueIdSchema.safeParse(p.id).success, p.id);
    }
  });

  test("the five personas exist, delays under two minutes, each used by at least one participant", () => {
    assert.deepEqual(SEED_PERSONAS.map((p) => p.persona).sort(), [...protocol.SIMULATED_PERSONAS].sort());
    for (const p of SEED_PERSONAS) assert.ok(p.delay_seconds >= 1 && p.delay_seconds <= protocol.SIMULATED_MAX_DELAY_SECONDS, p.persona);
    for (const persona of protocol.SIMULATED_PERSONAS) assert.ok(SEED_PARTICIPANTS.some((p) => p.persona === persona), persona);
    assert.ok(SEED_PERSONAS.find((p) => p.persona === "decline")?.decline_reason_code, "decline carries a reason code");
  });

  test("published terms and rules are valid protocol values", () => {
    for (const p of SEED_PARTICIPANTS) {
      assert.ok(protocol.RulesOfEngagementSchema.safeParse(p.rules).success, `${p.handle} rules`);
      assert.ok(protocol.RatingSummarySchema.safeParse(p.rating).success, `${p.handle} rating`);
      for (const t of p.topics) assert.ok(protocol.TopicSchema.safeParse(t).success, `${p.handle} topic`);
      assert.ok(p.topics.length >= 1);
    }
  });

  test("the set covers every request intent at least once among accepted types", () => {
    const accepted = new Set(SEED_PARTICIPANTS.flatMap((p) => p.rules.types.filter((t) => t.accepted).map((t) => t.intent)));
    for (const intent of protocol.INTENTS.filter((i) => i !== "authorisation")) assert.ok(accepted.has(intent), intent);
  });

  test("the proposal's validation topic is covered: patient-information leaflets, judgment", () => {
    assert.ok(SEED_PARTICIPANTS.some((p) => p.topics.some((t) => /leaflet/.test(t.topic)) && p.rules.types.some((t) => t.intent === "judgment" && t.accepted)));
  });

  test("seed/seed.sql is what seed/sql.ts renders (run pnpm --filter @a2h/db seed:sql)", () => {
    assert.equal(readFileSync(SEED_SQL_PATH, "utf8"), seedSql());
  });

  test("the first statement refuses to run unless a2h.stage is set and is not prod", () => {
    const first = statementsOf(SEED_SQL_PATH)[0]!;
    assert.match(first, /current_setting\('a2h\.stage', true\)/);
    assert.match(first, /'prod'/);
    assert.match(first, /RAISE EXCEPTION/);
  });
});

describe("seed on Postgres 17", { skip: skipWithoutDocker() }, () => {
  let pgc: PgContainer;
  let db: pg.Client;
  const statements = statementsOf(SEED_SQL_PATH);

  /** Applies the seed in one transaction, as db-migrate.sh does, with a2h.stage set to `stage` (or unset). */
  async function applySeed(stage: string | null): Promise<void> {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL search_path = pr_9");
      if (stage !== null) await db.query(`SELECT set_config('a2h.stage', $1, true)`, [stage]);
      for (const s of statements) await db.query(s);
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  }
  async function count(table: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pr_9.${table}`);
    return rows[0]!.n;
  }

  before(async () => {
    pgc = await startPostgres();
    db = new pg.Client({ connectionString: pgc.url });
    await db.connect();
    await migrate(db, "pr_9");
  });
  after(async () => {
    await db?.end().catch(() => undefined);
    pgc?.stop();
  });

  test("never on prod: the seed refuses and leaves nothing", async () => {
    await assert.rejects(applySeed("prod"), /never seeded on prod/);
    assert.equal(await count("participants"), 0);
  });

  test("never without a stage: the seed refuses and leaves nothing", async () => {
    await assert.rejects(applySeed(null), /never seeded on prod/);
    assert.equal(await count("participants"), 0);
  });

  test("Scenario: Redeploy: applying twice leaves twelve participants, once each", async () => {
    await applySeed("pr-9");
    await applySeed("pr-9");
    assert.equal(await count("participants"), 12);
    assert.equal(await count("profiles"), 12);
    assert.equal(await count("rules"), 12);
    assert.equal(await count("simulated_personas"), 5);
    const { rows } = await db.query<{ handle: string; n: number }>(`SELECT handle, count(*)::int AS n FROM pr_9.participants GROUP BY handle`);
    assert.deepEqual(rows.map((r) => r.handle).sort(), SEED_PARTICIPANTS.map((p) => p.handle).sort());
    assert.ok(rows.every((r) => r.n === 1));
    const types = SEED_PARTICIPANTS.reduce((n, p) => n + p.rules.types.length, 0);
    assert.equal(await count("rule_types"), types);
  });

  test("a re-seed updates published terms in place (upsert by handle), it does not add rows", async () => {
    await db.query(`UPDATE pr_9.participants SET display_label = 'Changed Name (simulated)' WHERE handle = $1`, [SEED_PARTICIPANTS[0]!.handle]);
    await db.query(`INSERT INTO pr_9.rule_types (participant_id, intent, accepted, reserve_net_minor, currency) VALUES ($1, 'referral', true, 1, 'EUR') ON CONFLICT DO NOTHING`, [SEED_PARTICIPANTS[0]!.id]);
    await applySeed("dev");
    const { rows } = await db.query<{ display_label: string }>(`SELECT display_label FROM pr_9.participants WHERE handle = $1`, [SEED_PARTICIPANTS[0]!.handle]);
    assert.equal(rows[0]!.display_label, SEED_PARTICIPANTS[0]!.display_label);
    assert.equal(await count("participants"), 12);
    assert.equal(await count("rule_types"), SEED_PARTICIPANTS.reduce((n, p) => n + p.rules.types.length, 0));
  });
});
