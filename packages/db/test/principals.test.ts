// m1-hosted-connector tasks 3.2 (design D4, D5) against PostgreSQL 17 in
// Docker: the queries of src/queries/principals.ts.
// Specs: platform/principal-identity "Allow-listed principals are verified by
// the owner's allow-list" (decision 8: created verified with the method
// `owner_allowlist`, an existing row never changed); platform/hosted-endpoint "Limit shared across instances" (the
// counter under concurrent callers on two connection pools, i.e. two
// instances); protocol/request-approval "Principal's own policy applies"
// (each principal reads its own policy row, created once from the stage
// default and never overwritten by a later consent).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { RATE_LIMIT_WINDOWS, rateLimitWindowStart, validateManifest, type Manifest, type ValidationFacts } from "@a2h/protocol";
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
    test("Scenario: Consent creates a verified principal: verified true, method owner_allowlist, policy from the stage default", async () => {
      const got = await ensurePrincipal(dbOf(poolA), "u_first", { policy: STAGE_DEFAULT });
      assert.deepEqual(got.principal, { principal_id: "u_first", identity_mode: "real_name", verified: true });
      assert.deepEqual(got.policy, STAGE_DEFAULT);
      assert.deepEqual(await principalWithPolicy(dbOf(poolB), "u_first"), got);
      const { rows } = await poolA.query<{ verified: boolean; verification_method: string | null }>(
        `SELECT verified, verification_method FROM principals WHERE principal_id = 'u_first'`,
      );
      assert.deepEqual(rows[0], { verified: true, verification_method: "owner_allowlist" });
    });

    test("Scenario: Second consent leaves verification as stored: an unverified row without a method stays so", async () => {
      // A row from before decision 8 (or flipped by hand): verified false, no method.
      await poolA.query(`INSERT INTO principals (principal_id, identity_mode, verified) VALUES ('u_before_d8', 'real_name', false)`);
      const second = await ensurePrincipal(dbOf(poolA), "u_before_d8", { policy: STAGE_DEFAULT });
      assert.equal(second.principal.verified, false);
      const { rows } = await poolA.query<{ verified: boolean; verification_method: string | null }>(
        `SELECT verified, verification_method FROM principals WHERE principal_id = 'u_before_d8'`,
      );
      assert.deepEqual(rows[0], { verified: false, verification_method: null });
    });

    test("Scenario: Signed-in principal can send: the principal as stored passes validation's principal stage", async () => {
      const { principal } = await ensurePrincipal(dbOf(poolA), "u_sender", { policy: STAGE_DEFAULT });
      const manifest: Manifest = {
        to: "sim-mv-7f3c",
        intent: "judgment",
        audience: "named_individual",
        time_shape: "one_shot",
        format: "single_field",
        question: "Is this patient-information leaflet clear for a newly diagnosed reader?",
        lane: "paid",
        bid_minor: 3500,
        currency: "EUR",
        expires_at: "2026-10-22T16:42:00+02:00",
        data_terms: { storage: "principal_workspace", attribution: "not_attributed", training: "off" },
        principal_id: principal.principal_id,
      };
      const facts: ValidationFacts = {
        now: "2026-10-21T08:42:00+02:00",
        principal,
        participant: {
          participant_id: "p_sim_mv",
          handle: "sim-mv-7f3c",
          rules: {
            types: [{ intent: "judgment", accepted: true, reserve_net_minor: 2500, currency: "EUR" }],
            free_lanes: [],
            who_may_ask: "anyone_verified",
            quiet_hours: { start: "22:00", end: "07:00", time_zone: "Europe/Paris" },
            max_interruptions_per_day: 3,
            latency_promise_seconds: 86400,
          },
        },
        interruptions_today: 0,
        budget: { used_minor: 0, currency: "EUR" },
        requests_today: 0,
        principal_throttled: false,
        approval: "pending",
      };
      const r = validateManifest(manifest, facts, { ...STAGE_DEFAULT, fee_rate: 0.2 });
      assert.equal(r.ok ? "passed" : r.error.stage, "passed", JSON.stringify(r));
      // The same manifest under an unverified principal is refused at that stage: the test can fail.
      const refused = validateManifest(manifest, { ...facts, principal: { ...principal, verified: false } }, { ...STAGE_DEFAULT, fee_rate: 0.2 });
      assert.equal(refused.ok ? "passed" : refused.error.code, "principal_not_accountable");
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
