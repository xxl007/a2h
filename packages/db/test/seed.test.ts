// Task 3.2: the simulated set (spec platform/participant-simulation).
// Content checks run without a database; "Redeploy" and the production guard
// run on Postgres 17 in Docker. tests/ci/db-migrate.test.sh checks the same
// through db-migrate.sh.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import pg from "pg";
import * as protocol from "@a2h/protocol";
import { SEED_DEV_BUDGET_MULTIPLIER, SEED_PERSONAS, SEED_PARTICIPANTS, SEED_PRINCIPAL, SEED_PRINCIPAL_POLICY } from "../seed/simulated.ts";
import { principalWithPolicy } from "../src/index.ts";
import { drizzle } from "drizzle-orm/node-postgres";
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

  test("who may ask: one persona takes organisations only, sim-rc-8d14, which no live flow sends to; the silent persona takes anyone verified", () => {
    // Since m1-hosted-connector the live suites call as a signed-in principal, a
    // person (identity_mode real_name): an organisation-only persona refuses them
    // (validate.ts "asker_not_allowed"). The silent persona must take them, or
    // "Silent until expiry" cannot run live (pr-60); the organisation-only rule
    // stays proved live by a refusal to sim-rc-8d14 (tests/contract
    // request-approval.test.ts "Blocked row") and at delivery (apps/worker
    // deliver.test.ts), and discovery only ever reads sim-rc-8d14.
    const orgOnly = SEED_PARTICIPANTS.filter((p) => p.rules.who_may_ask === "organisations_only").map((p) => p.handle);
    assert.deepEqual(orgOnly, ["sim-rc-8d14"]);
    const silent = SEED_PARTICIPANTS.find((p) => p.handle === "sim-hb-1f7d");
    assert.equal(silent?.persona, "silent");
    assert.equal(silent?.rules.who_may_ask, "anyone_verified");
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

// Daily interruption caps (fix after verify pr-89, run 42296878001, 2026-11-06).
// A stage's schema persists across verify runs, and the daily count is per
// participant per UTC day across every principal (packages/db countDeliveries),
// so the third verify of a day spent sim-jw-9e48's ten and the first contract
// flow was refused outside_participant_rules. Simulated personas exist on dev
// and previews only, so their caps are test data: one persona keeps a small cap
// for the scenario that exhausts it on purpose, every other one takes more than
// a day of CI can send.
describe("daily interruption caps", () => {
  /** The persona "Interruption budget exceeded" exhausts: cap 2, as the live tests assume. */
  const CAP_PERSONA = "sim-bk-2e6f";
  const CAP = 2;
  /** The only CI suites that may send to it, both exhausting the budget on purpose. */
  const CAP_PERSONA_SUITES = ["tests/adversarial/manifest.live.test.ts", "tests/contract/request-approval.test.ts"];
  /** A day of CI (several verify runs, each a handful of requests per persona) cannot reach this. */
  const CI_SAFE_CAP = 1000;

  test(`the scenario persona ${CAP_PERSONA} keeps a cap of ${CAP}, no quiet hours`, () => {
    const bk = SEED_PARTICIPANTS.find((p) => p.handle === CAP_PERSONA);
    assert.equal(bk?.rules.max_interruptions_per_day, CAP);
    assert.equal(bk?.rules.quiet_hours, null);
  });

  test(`every other simulated persona takes at least ${CI_SAFE_CAP} interruptions a day`, () => {
    for (const p of SEED_PARTICIPANTS) {
      if (p.handle === CAP_PERSONA) continue;
      assert.ok(
        p.rules.max_interruptions_per_day >= CI_SAFE_CAP,
        `${p.handle}: max_interruptions_per_day ${p.rules.max_interruptions_per_day} can be spent by a day of CI on one stage`,
      );
    }
  });

  test(`no other CI flow names ${CAP_PERSONA}: under tests/ and apps/web only the two interruption-budget suites do`, () => {
    const root = new URL("../../../", import.meta.url).pathname;
    const skip = new Set(["node_modules", "dist", ".next", ".turbo", "test-results", "playwright-report", "coverage"]);
    const naming: string[] = [];
    for (const dir of ["tests", "apps/web"]) {
      for (const d of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
        const path = join(d.parentPath, d.name);
        if (!d.isFile() || !/\.(ts|tsx|mts|js|mjs|cjs)$/.test(d.name)) continue;
        if (relative(root, path).split(sep).some((part) => skip.has(part))) continue;
        const source = readFileSync(path, "utf8");
        if (!source.includes(CAP_PERSONA)) continue;
        naming.push(relative(root, path));
        assert.match(source, /interruption budget/i, `${relative(root, path)} names ${CAP_PERSONA} without being about the interruption budget`);
      }
    }
    assert.deepEqual(naming.sort(), [...CAP_PERSONA_SUITES].sort());
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

  // m1-hosted-connector (design Migration Plan, rollback AUTH_REQUIRED=false):
  // with the gate off, the mcp service acts for `dev-principal-<stage>`, so
  // the seed gives that principal its rows, as consent does for a real one.
  test("the stage's fallback principal dev-principal-<stage> is seeded with the stage default policy, never overwritten", async () => {
    await applySeed("pr-9");
    await db.query(`SET search_path = pr_9`);
    try {
      const read = (id: string) => principalWithPolicy(drizzle(db), id);
      const pr = await read("dev-principal-pr-9");
      assert.deepEqual(pr, { principal: { principal_id: "dev-principal-pr-9", ...SEED_PRINCIPAL }, policy: SEED_PRINCIPAL_POLICY });
      await applySeed("dev");
      const dev = await read("dev-principal-dev");
      assert.equal(dev?.policy.monthly_budget_minor, SEED_PRINCIPAL_POLICY.monthly_budget_minor * SEED_DEV_BUDGET_MULTIPLIER);
      // A policy edited since is kept by a re-seed.
      await db.query(`UPDATE principal_policies SET monthly_budget_minor = 7 WHERE principal_id = 'dev-principal-pr-9'`);
      await applySeed("pr-9");
      assert.equal((await read("dev-principal-pr-9"))?.policy.monthly_budget_minor, 7);
      assert.equal(await count("principals"), 2);
    } finally {
      await db.query(`RESET search_path`);
    }
  });
});
