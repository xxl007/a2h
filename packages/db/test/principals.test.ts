// m1-hosted-connector tasks 3.2 (design D4, D5) against PostgreSQL 17 in
// Docker: the queries of src/queries/principals.ts.
// Specs: platform/hosted-endpoint "Limit shared across instances" (the
// counter under concurrent callers on two connection pools, i.e. two
// instances); protocol/request-approval "Principal's own policy applies"
// (each principal reads its own policy row, created once from the stage
// default and never overwritten by a later consent).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { RATE_LIMIT_WINDOWS, rateLimitWindowStart } from "@a2h/protocol";
import {
  bumpRateLimit,
  ensurePrincipal,
  principalWithPolicy,
  pruneRateLimitWindows,
  type PrincipalPolicy,
} from "../src/queries/principals.ts";
import { migrate, skipWithoutDocker, startPostgres, type PgContainer } from "./lib/postgres.ts";

const skip = skipWithoutDocker();
const SCHEMA = "pr_9";

/** infra/config.ts DEVELOPMENT_POLICY without the platform's fee rate. */
const STAGE_DEFAULT: PrincipalPolicy = {
  currency: "EUR",
  monthly_budget_minor: 50_000,
  per_request_cap_minor: 6_000,
  ask_first_above_minor: null,
  daily_request_limit: 50,
  throttled_daily_limit: 5,
};

let pgc: PgContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
const dbOf = (pool: pg.Pool) => drizzle(pool);

describe("principal queries (Postgres 17)", { skip }, () => {
  before(async () => {
    pgc = await startPostgres();
    const admin = new pg.Client({ connectionString: pgc.url });
    await admin.connect();
    await migrate(admin, SCHEMA);
    await admin.end();
    // Two pools stand for two instances of the mcp service on one stage.
    const opts = { connectionString: pgc.url, options: `-c search_path=${SCHEMA}`, max: 10 };
    poolA = new pg.Pool(opts);
    poolB = new pg.Pool(opts);
  });
  after(async () => {
    await poolA?.end().catch(() => undefined);
    await poolB?.end().catch(() => undefined);
    pgc?.stop();
  });

  describe("principalWithPolicy", () => {
    test("an unknown principal is null", async () => {
      assert.equal(await principalWithPolicy(dbOf(poolA), "u_unknown"), null);
    });
  });

  describe("ensurePrincipal (created on consent, design D4)", () => {
    test("creates the principal and its policy from the stage default", async () => {
      const got = await ensurePrincipal(dbOf(poolA), "u_first", { policy: STAGE_DEFAULT });
      assert.deepEqual(got.principal, { principal_id: "u_first", identity_mode: "real_name", verified: false });
      assert.deepEqual(got.policy, STAGE_DEFAULT);
      assert.deepEqual(await principalWithPolicy(dbOf(poolB), "u_first"), got);
    });

    test("idempotent: a second call returns the existing rows unchanged, whatever defaults it brings", async () => {
      const db = dbOf(poolA);
      const first = await ensurePrincipal(db, "u_again", { policy: STAGE_DEFAULT });
      await poolA.query(`UPDATE principals SET verified = true WHERE principal_id = 'u_again'`);
      await poolA.query(`UPDATE principal_policies SET monthly_budget_minor = 1234 WHERE principal_id = 'u_again'`);
      const second = await ensurePrincipal(db, "u_again", {
        identity_mode: "verified_organisation",
        policy: { ...STAGE_DEFAULT, monthly_budget_minor: 999_999, ask_first_above_minor: 0 },
      });
      assert.deepEqual(second.principal, { ...first.principal, verified: true });
      assert.deepEqual(second.policy, { ...STAGE_DEFAULT, monthly_budget_minor: 1234 });
      const { rows } = await poolA.query<{ p: number; q: number }>(
        `SELECT (SELECT count(*)::int FROM principals WHERE principal_id = 'u_again') AS p,
                (SELECT count(*)::int FROM principal_policies WHERE principal_id = 'u_again') AS q`,
      );
      assert.deepEqual(rows[0], { p: 1, q: 1 });
    });

    test("two consents at once for the same account create one principal and one policy", async () => {
      const [a, b] = await Promise.all([
        ensurePrincipal(dbOf(poolA), "u_race", { policy: STAGE_DEFAULT }),
        ensurePrincipal(dbOf(poolB), "u_race", { policy: { ...STAGE_DEFAULT, daily_request_limit: 7 } }),
      ]);
      assert.deepEqual(a, b);
    });

    test("one transaction: if the policy cannot be written, no principal row is left behind", async () => {
      await assert.rejects(ensurePrincipal(dbOf(poolA), "u_bad", { policy: { ...STAGE_DEFAULT, monthly_budget_minor: -1 } }));
      assert.equal(await principalWithPolicy(dbOf(poolA), "u_bad"), null);
      const { rows } = await poolA.query<{ n: number }>(`SELECT count(*)::int AS n FROM principals WHERE principal_id = 'u_bad'`);
      assert.equal(rows[0]?.n, 0);
    });

    test("runs inside the caller's transaction (the consent step): rolled back with it", async () => {
      const db = dbOf(poolA);
      await assert.rejects(
        db.transaction(async (tx) => {
          await ensurePrincipal(tx, "u_consent_rolled_back", { policy: STAGE_DEFAULT });
          throw new Error("consent not recorded");
        }),
        /consent not recorded/,
      );
      assert.equal(await principalWithPolicy(db, "u_consent_rolled_back"), null);
    });

    test("Principal's own policy applies: two principals read their own rows, never the other's", async () => {
      const db = dbOf(poolA);
      await ensurePrincipal(db, "u_alice", { policy: STAGE_DEFAULT });
      await ensurePrincipal(db, "u_bob", { policy: { ...STAGE_DEFAULT, per_request_cap_minor: 100 } });
      assert.equal((await principalWithPolicy(db, "u_alice"))?.policy.per_request_cap_minor, 6_000);
      assert.equal((await principalWithPolicy(db, "u_bob"))?.policy.per_request_cap_minor, 100);
    });
  });

  describe("bumpRateLimit (design D5)", () => {
    const at = new Date("2026-10-27T09:00:42.123Z");
    before(async () => {
      await ensurePrincipal(dbOf(poolA), "u_rl", { policy: STAGE_DEFAULT });
      await ensurePrincipal(dbOf(poolA), "u_rl_other", { policy: STAGE_DEFAULT });
    });

    test("the first call in a window counts 1, the next 2; another window or another principal starts at 1", async () => {
      const db = dbOf(poolA);
      const minute = rateLimitWindowStart("minute", at);
      assert.equal(await bumpRateLimit(db, "u_rl", "minute", minute), 1);
      assert.equal(await bumpRateLimit(db, "u_rl", "minute", minute), 2);
      assert.equal(await bumpRateLimit(db, "u_rl", "day", rateLimitWindowStart("day", at)), 1);
      assert.equal(await bumpRateLimit(db, "u_rl", "minute", rateLimitWindowStart("minute", new Date(at.getTime() + 60_000))), 1);
      assert.equal(await bumpRateLimit(db, "u_rl_other", "minute", minute), 1);
    });

    test("Scenario: Limit shared across instances: 20 parallel bumps over two instances give counts 1..20, each exactly once", async () => {
      const start = rateLimitWindowStart("minute", new Date("2026-10-27T10:15:07Z"));
      const counts = await Promise.all(
        Array.from({ length: 20 }, (_, i) => bumpRateLimit(dbOf(i % 2 === 0 ? poolA : poolB), "u_rl", "minute", start)),
      );
      assert.deepEqual([...counts].sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
      const { rows } = await poolA.query<{ count: number }>(
        `SELECT count FROM rate_limit_windows WHERE principal_id = 'u_rl' AND window_kind = 'minute' AND window_start = $1`,
        [start],
      );
      assert.equal(rows[0]?.count, 20);
    });

    test("a window start off its UTC boundary is refused by the database, not silently counted apart", async () => {
      await assert.rejects(bumpRateLimit(dbOf(poolA), "u_rl", "minute", at));
    });

    test("an unknown principal is refused (no counter without a principal row)", async () => {
      await assert.rejects(bumpRateLimit(dbOf(poolA), "u_nobody", "minute", rateLimitWindowStart("minute", at)));
    });

    test("every window kind of the protocol is accepted", async () => {
      for (const kind of RATE_LIMIT_WINDOWS) assert.ok((await bumpRateLimit(dbOf(poolA), "u_rl_other", kind, rateLimitWindowStart(kind, at))) >= 1);
    });
  });

  describe("pruneRateLimitWindows (design D5: windows older than a day go)", () => {
    test("deletes windows that started before the cut-off, keeps the rest, returns how many went", async () => {
      const db = dbOf(poolA);
      await ensurePrincipal(db, "u_prune", { policy: STAGE_DEFAULT });
      const old1 = new Date("2026-10-20T08:00:00Z");
      const old2 = new Date("2026-10-20T00:00:00Z");
      const recent = new Date("2026-10-27T08:59:00Z");
      await bumpRateLimit(db, "u_prune", "minute", old1);
      await bumpRateLimit(db, "u_prune", "day", old2);
      await bumpRateLimit(db, "u_prune", "minute", recent);
      const before = (await poolA.query<{ n: number }>(`SELECT count(*)::int AS n FROM rate_limit_windows WHERE window_start < '2026-10-26T09:00:00Z'`)).rows[0]?.n;
      const removed = await pruneRateLimitWindows(db, new Date("2026-10-26T09:00:00Z"));
      assert.equal(removed, before);
      assert.ok(removed >= 2);
      const left = await poolA.query<{ window_start: Date }>(`SELECT window_start FROM rate_limit_windows WHERE principal_id = 'u_prune'`);
      assert.deepEqual(left.rows.map((r) => r.window_start.toISOString()), [recent.toISOString()]);
      assert.equal(await pruneRateLimitWindows(db, new Date("2026-10-26T09:00:00Z")), 0);
    });
  });
});
