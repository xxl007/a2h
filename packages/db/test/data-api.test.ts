// The shared queries through the Data API driver (apps/web's path, ADR 0001
// amendment 2) against PostgreSQL 17, via test/lib/data-api.ts: Drizzle's
// own `drizzle-orm/aws-data-api/pg` driver, with every parameter bound as
// the Data API types it. Guards the class of bug pr-82 hit on 2026-11-03
// (`principalUsage` compared a timestamptz with an ISO string in raw SQL:
// fine on node-postgres, 42883 on Aurora): any query of packages/db the web
// app reaches runs here.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import { approvalTokenHash, formatApprovalToken, type Manifest } from "@a2h/protocol";
import {
  approvalFacts,
  bumpRateLimit,
  countDeliveries,
  createAwaitingRequest,
  currentRules,
  decideApproval,
  dueApprovals,
  ensurePrincipal,
  expireApproval,
  findPublishedParticipant,
  findRequests,
  principalUsage,
  principalWithPolicy,
  pruneRateLimitWindows,
  recordBlockedManifest,
  RequestIdTaken,
  requests,
  sql,
  type A2hDb,
} from "../src/index.ts";
import { SEED_SQL_PATH } from "../seed/sql.ts";
import { DatabaseErrorException, dataApiStandIn, type DataApiStandIn } from "./lib/data-api.ts";
import { migrate, skipWithoutDocker, startPostgres, statementsOf, type PgContainer } from "./lib/postgres.ts";

const skip = skipWithoutDocker();
const SCHEMA = "pr_dataapi";
const NOW = new Date("2026-10-27T09:00:00Z");
const LATER = new Date(NOW.getTime() + 3_600_000);
const P = "user-data-api";
const OTHER = "user-data-api-other";
const POLICY = { currency: "EUR", monthly_budget_minor: 50_000, per_request_cap_minor: 6_000, ask_first_above_minor: null, daily_request_limit: 50, throttled_daily_limit: 5 };
const QUESTION = "Would a patient with type 2 diabetes find the attached leaflet's section on insulin alarming?";
const EDITED = "Would a newly diagnosed patient find the insulin section alarming? (é, «quotes», 中文)";
const PUSH_POLL = "Would you still trust this clinic if you learned its director lied about the results?";

const manifest: Manifest = {
  to: "sim-mv-7f3c",
  intent: "judgment",
  audience: "named_individual",
  time_shape: "one_shot",
  format: "single_field",
  question: QUESTION,
  lane: "paid",
  bid_minor: 3200,
  currency: "EUR",
  expires_at: "2026-10-29T09:00:00+00:00",
  data_terms: { storage: "principal_workspace", attribution: "attributed", training: "off" },
  principal_id: P,
};

let pgc: PgContainer;
let api: DataApiStandIn;
let db: A2hDb;

describe("packages/db queries through the Data API driver (Postgres 17)", { skip }, () => {
  before(async () => {
    pgc = await startPostgres();
    const c = new pg.Client({ connectionString: pgc.url });
    await c.connect();
    await migrate(c, SCHEMA);
    await c.query("BEGIN");
    await c.query(`SET LOCAL search_path = ${SCHEMA}`);
    await c.query(`SELECT set_config('a2h.stage', 'test', true)`);
    for (const s of statementsOf(SEED_SQL_PATH)) await c.query(s);
    await c.query("COMMIT");
    await c.end();
    api = dataApiStandIn(pgc.url, SCHEMA);
    db = drizzle(api.client as never, { database: "a2h", resourceArn: "arn:aws:rds:eu-west-3:123456789012:cluster:test", secretArn: "arn:aws:secretsmanager:eu-west-3:123456789012:secret:test" });
  });
  after(async () => {
    await api?.close();
    pgc?.stop();
  });

  test("the stand-in reproduces pr-82: a raw-SQL ISO string against a timestamptz fails as on Aurora (42883)", async () => {
    await assert.rejects(
      db.execute(sql`SELECT count(*) FROM ${requests} WHERE ${requests.created_at} >= ${NOW.toISOString()}`),
      (e: unknown) => {
        // Drizzle wraps the driver's error ("Failed query: …") with Postgres's as the cause.
        assert.match(String((e as Error).cause), /operator does not exist: timestamp with time zone >= text/);
        return true;
      },
    );
  });

  test("the stand-in reproduces pr-82 (run 41667737147): two statements in flight on one transaction fail as on Aurora", async () => {
    const isBusy = (e: unknown) => {
      const err = (e as Error).cause ?? e;
      assert.ok(err instanceof DatabaseErrorException, String(e));
      assert.equal(err.message, "Transaction is still running a query");
      return true;
    };
    await assert.rejects(
      db.transaction(async (tx) => {
        await Promise.all([tx.execute(sql`SELECT pg_sleep(0.05)`), tx.execute(sql`SELECT 1`)]);
      }),
      isBusy,
    );
    // One after the other on the same transaction, and concurrently outside one, are fine.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_sleep(0.01)`);
      await tx.execute(sql`SELECT 1`);
    });
    await Promise.all([db.execute(sql`SELECT pg_sleep(0.01)`), db.execute(sql`SELECT 1`)]);
  });

  test("principals: ensurePrincipal, principalWithPolicy, bumpRateLimit, pruneRateLimitWindows", async () => {
    for (const id of [P, OTHER]) await ensurePrincipal(db, id, { policy: POLICY });
    const found = await principalWithPolicy(db, P);
    assert.equal(found?.principal.principal_id, P);
    assert.equal(found?.policy.monthly_budget_minor, 50_000);
    assert.equal(await bumpRateLimit(db, P, "day", new Date("2026-10-27T00:00:00Z")), 1);
    assert.equal(await bumpRateLimit(db, P, "day", new Date("2026-10-27T00:00:00Z")), 2);
    assert.equal(await pruneRateLimitWindows(db, new Date("2026-10-28T00:00:00Z")), 1);
  });

  async function awaiting(id: string, expiresAt = new Date(NOW.getTime() + 24 * 3_600_000)): Promise<string> {
    const token = formatApprovalToken(Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + id.charCodeAt(7)) & 255));
    const participant = (await findPublishedParticipant(db, "sim-mv-7f3c"))!;
    await createAwaitingRequest(db, {
      id,
      manifest,
      participant_id: participant.participant_id,
      deliver_at: NOW,
      approval_token_hash: await approvalTokenHash(token),
      approval_expires_at: expiresAt,
      now: NOW,
    });
    return token;
  }

  const decision = (id: string, token: string, kind: "send" | "dont_send", o: { question?: string; principal?: string; now?: Date } = {}) => ({
    request_id: id,
    token,
    principal_id: o.principal ?? P,
    now: o.now ?? LATER,
    fee_rate: 0.2,
    decision: kind === "send" ? { kind: "send" as const, question: o.question ?? QUESTION } : { kind: "dont_send" as const },
  });

  test("the approval queries: createAwaitingRequest, approvalFacts, decideApproval in every outcome, expireApproval, dueApprovals", async () => {
    const participant = (await findPublishedParticipant(db, "sim-mv-7f3c"))!;
    assert.deepEqual(participant.rules.free_lanes, ["own_publications"], "a varchar[] read back through the Data API");
    assert.ok((await currentRules(db, participant.participant_id)).types.length > 0);

    const a = await awaiting("A2H-da01");
    const facts = await approvalFacts(db, { principal: (await principalWithPolicy(db, P))!.principal, currency: "EUR", participant, now: NOW, approval: "recorded" });
    assert.deepEqual([facts.interruptions_today, facts.requests_today, facts.budget.used_minor], [0, 0, 0]);

    assert.deepEqual(await decideApproval(db, decision("A2H-da01", a, "send", { principal: OTHER })), { kind: "wrong_principal" });
    assert.equal((await decideApproval(db, decision("A2H-da01", a, "send", { question: PUSH_POLL }))).kind, "invalid");
    const sent = await decideApproval(db, decision("A2H-da01", a, "send", { question: EDITED }));
    assert.equal(sent.kind, "sent", JSON.stringify(sent));
    const again = await decideApproval(db, decision("A2H-da01", a, "dont_send"));
    assert.equal(again.kind, "already_decided");
    if (again.kind === "already_decided") assert.equal(again.decided_at, LATER.toISOString());
    assert.deepEqual(await decideApproval(db, decision("A2H-da01", formatApprovalToken(new Uint8Array(32).fill(3)), "send")), { kind: "link_invalid" });

    // Counted once sent: the queries that compare timestamps (principalUsage, countDeliveries).
    const dayStart = new Date("2026-10-27T00:00:00Z");
    assert.deepEqual(await principalUsage(db, P, new Date("2026-10-01T00:00:00Z"), dayStart), { committed_minor: 3200, requests_today: 1 });
    assert.equal(await countDeliveries(db, participant.participant_id, dayStart, new Date(dayStart.getTime() + 86_400_000)), 1);
    const after = await approvalFacts(db, { principal: (await principalWithPolicy(db, P))!.principal, currency: "EUR", participant, now: LATER, approval: "recorded" });
    assert.deepEqual([after.interruptions_today, after.requests_today, after.budget.used_minor], [1, 1, 3200]);

    const b = await awaiting("A2H-da02");
    assert.deepEqual(await decideApproval(db, decision("A2H-da02", b, "dont_send")), { kind: "not_sent", reason: "declined" });

    const c = await awaiting("A2H-da03", new Date(NOW.getTime() + 60_000));
    assert.deepEqual(await dueApprovals(db, new Date(NOW.getTime() + 60_000), 10), ["A2H-da03"]);
    assert.equal(await expireApproval(db, "A2H-da03", new Date(NOW.getTime() + 60_000)), true);
    assert.deepEqual(await decideApproval(db, decision("A2H-da03", c, "send")), { kind: "expired" });

    const [row] = await findRequests(db as never, P, { request_id: "A2H-da01" });
    assert.equal(row?.status, "sent");
    assert.ok(row?.created_at instanceof Date && row.created_at.getTime() === NOW.getTime(), String(row?.created_at));
    assert.deepEqual((await findRequests(db as never, P, { status: "not_sent", since: NOW, limit: 10 })).map((r) => r.id).sort(), ["A2H-da02", "A2H-da03"]);
  });

  test("the stand-in reproduces pr-85 (run 42246226973): a duplicate key is a DatabaseErrorException with the SQLState and constraint only in its message", async () => {
    await awaiting("A2H-da0e");
    await assert.rejects(
      db.execute(sql`INSERT INTO ${requests} SELECT * FROM ${requests} WHERE ${requests.id} = ${"A2H-da0e"}`),
      (e: unknown) => {
        const cause = (e as Error).cause as Error & { code?: unknown; constraint?: unknown };
        assert.ok(cause instanceof DatabaseErrorException, String(e));
        assert.equal(cause.message, 'duplicate key value violates unique constraint "requests_pkey"; SQLState: 23505');
        assert.equal(cause.code, undefined, "the Data API has no code field");
        assert.equal(cause.constraint, undefined, "the Data API has no constraint field");
        return true;
      },
    );
  });

  test("createAwaitingRequest on a taken id is RequestIdTaken through the Data API too (pr-85, the web fixture route); the caller draws another", async () => {
    await awaiting("A2H-da0f");
    await assert.rejects(awaiting("A2H-da0f"), RequestIdTaken);
    // Nothing half-written: one request, one event.
    const [row] = await findRequests(db as never, P, { request_id: "A2H-da0f" });
    assert.equal(row?.events.length, 1);
  });

  test("recordBlockedManifest", async () => {
    const participant = (await findPublishedParticipant(db, "sim-mv-7f3c"))!;
    await recordBlockedManifest(db, { participant_id: participant.participant_id, principal_id: P, stage: "rules", code: "bid_below_reserve", at: NOW.toISOString() });
  });

  test("decideApproval Send reads its validation facts one statement at a time on its transaction (pr-82, run 41667737147)", async () => {
    await ensurePrincipal(db, P, { policy: POLICY });
    const t = await awaiting("A2H-da10");
    // On Aurora the second fact query failed with "Transaction is still running a query"; surface that cause if it recurs.
    const sent = await decideApproval(db, decision("A2H-da10", t, "send")).catch((e: unknown) => {
      throw new Error(`decideApproval rejected: ${String((e as Error).cause ?? e)}`);
    });
    assert.equal(sent.kind, "sent", JSON.stringify(sent));
  });

  test("no statement sent a Date or an ISO date-time as an untyped (text) parameter", () => {
    const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
    const offenders = api.statements.flatMap((s) =>
      s.parameters.filter((p) => p.value.stringValue !== undefined && iso.test(p.value.stringValue) && !p.typeHint).map((p) => `${p.value.stringValue} in ${s.sql.slice(0, 120)}`),
    );
    // The pr-82 reproduction above is the one deliberate offender.
    assert.equal(offenders.length, 1, offenders.join("\n"));
  });
});
