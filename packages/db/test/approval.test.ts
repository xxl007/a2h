// m2-approval-page task 2.2 against PostgreSQL 17: the awaiting-approval
// request (design D1), the decision transaction both apps call (D4), the
// approval link's expiry (D6), and the shared loaders. Scenario names are
// those of the change's spec deltas (protocol/request-approval,
// protocol/request-lifecycle); the page and its session are apps/web's.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { approvalTokenHash, formatApprovalToken, type Manifest, type ValidationPolicy } from "@a2h/protocol";
import {
  approvalFacts,
  countDeliveries,
  createAwaitingRequest,
  decideApproval,
  ensurePrincipal,
  expireApproval,
  findPublishedParticipant,
  principalUsage,
  RequestIdTaken,
  type A2hDb,
} from "../src/index.ts";
import { SEED_SQL_PATH } from "../seed/sql.ts";
import { migrate, skipWithoutDocker, startPostgres, statementsOf, type PgContainer } from "./lib/postgres.ts";

const skip = skipWithoutDocker();
const NOW = new Date("2026-10-27T09:00:00Z"); // Tuesday 10:00 in Paris, outside every seeded quiet window
const LATER = new Date(NOW.getTime() + 3_600_000);
const PRINCIPAL = "user-approval-principal";
const OTHER = "user-other-principal";
const POLICY: ValidationPolicy = {
  fee_rate: 0.2,
  currency: "EUR",
  monthly_budget_minor: 50_000,
  per_request_cap_minor: 6_000,
  ask_first_above_minor: null,
  daily_request_limit: 50,
  throttled_daily_limit: 5,
};
const OWN_POLICY = { currency: POLICY.currency, monthly_budget_minor: POLICY.monthly_budget_minor, per_request_cap_minor: POLICY.per_request_cap_minor, ask_first_above_minor: POLICY.ask_first_above_minor, daily_request_limit: POLICY.daily_request_limit, throttled_daily_limit: POLICY.throttled_daily_limit };
const ORIGINAL = "Would a patient with type 2 diabetes find the attached leaflet's section on insulin alarming?";
const EDITED = "Would a newly diagnosed patient find the insulin section alarming? (é, «quotes», 中文)\nLine two.";
const PUSH_POLL = "Would you still trust this clinic if you learned its director lied about the results?";

function manifest(over: Partial<Manifest> = {}): Manifest {
  const m: Manifest = {
    to: "sim-mv-7f3c",
    intent: "judgment",
    audience: "named_individual",
    time_shape: "one_shot",
    format: "single_field",
    question: ORIGINAL,
    lane: "paid",
    bid_minor: 3200,
    currency: "EUR",
    expires_at: "2026-10-29T09:00:00+00:00",
    data_terms: { storage: "principal_workspace", attribution: "attributed", training: "off" },
    principal_id: PRINCIPAL,
  };
  return { ...m, ...over };
}

let pgc: PgContainer;
let schemas = 0;

interface Fresh {
  db: A2hDb;
  pool: pg.Pool;
  sql: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;
}
const pools: pg.Pool[] = [];

/** A migrated, seeded schema with the two principals; a pool of 4 connections on it. */
async function fresh(): Promise<Fresh> {
  const schema = `a${process.pid}_${++schemas}`;
  const client = new pg.Client({ connectionString: pgc.url });
  await client.connect();
  try {
    await migrate(client, schema);
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path = ${schema}`);
    await client.query(`SELECT set_config('a2h.stage', 'test', true)`);
    for (const statement of statementsOf(SEED_SQL_PATH)) await client.query(statement);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
  const pool = new pg.Pool({ connectionString: pgc.url, max: 4, options: `-c search_path=${schema}` });
  pools.push(pool);
  const db = drizzle(pool) as unknown as A2hDb;
  for (const id of [PRINCIPAL, OTHER]) await ensurePrincipal(db, id, { policy: OWN_POLICY });
  const sql = async <T,>(text: string, values: unknown[] = []) => (await pool.query(text, values)).rows as T[];
  return { db, pool, sql };
}

interface Awaiting {
  id: string;
  token: string;
}

let ids = 0;
async function awaiting(f: Fresh, over: { manifest?: Partial<Manifest>; expiresAt?: Date; id?: string } = {}): Promise<Awaiting> {
  const id = over.id ?? `A2H-${(0xa000 + ++ids).toString(16)}`;
  const token = formatApprovalToken(Uint8Array.from({ length: 32 }, (_, i) => (i * 31 + ids) & 255));
  const m = manifest(over.manifest);
  const participant = (await findPublishedParticipant(f.db, m.to))!;
  await createAwaitingRequest(f.db, {
    id,
    manifest: m,
    participant_id: participant.participant_id,
    deliver_at: NOW,
    approval_token_hash: await approvalTokenHash(token),
    approval_expires_at: over.expiresAt ?? new Date(NOW.getTime() + 24 * 3_600_000),
    now: NOW,
  });
  return { id, token };
}

async function row(f: Fresh, id: string) {
  const [r] = await f.sql<{ status: string; question: string; agent_draft: string; not_sent_reason: string | null; deliver_at: Date }>(
    "SELECT status, question, agent_draft, not_sent_reason, deliver_at FROM requests WHERE id = $1",
    [id],
  );
  return r!;
}
async function events(f: Fresh, id: string) {
  return f.sql<{ from_status: string | null; to_status: string; actor: string }>(
    "SELECT from_status, to_status, actor FROM request_events WHERE request_id = $1 ORDER BY id",
    [id],
  );
}
async function deliveries(f: Fresh, id: string): Promise<number> {
  const [r] = await f.sql<{ n: number }>("SELECT count(*)::int AS n FROM request_deliveries WHERE request_id = $1", [id]);
  return r!.n;
}

const send = (a: Awaiting, question = ORIGINAL, over: { principal_id?: string; now?: Date; token?: string } = {}) => ({
  request_id: a.id,
  token: over.token ?? a.token,
  principal_id: over.principal_id ?? PRINCIPAL,
  now: over.now ?? LATER,
  fee_rate: POLICY.fee_rate,
  decision: { kind: "send" as const, question },
});
const dontSend = (a: Awaiting, over: { principal_id?: string; now?: Date } = {}) => ({
  request_id: a.id,
  token: a.token,
  principal_id: over.principal_id ?? PRINCIPAL,
  now: over.now ?? LATER,
  fee_rate: POLICY.fee_rate,
  decision: { kind: "dont_send" as const },
});

describe("approval queries (m2-approval-page 2.2, Postgres 17)", { skip }, () => {
  before(async () => {
    pgc = await startPostgres();
  });
  after(async () => {
    for (const p of pools) await p.end().catch(() => undefined);
    pgc?.stop();
  });

  describe("createAwaitingRequest (D1)", () => {
    test("Scenario: Link returned (data part): the row is awaiting_approval with the agent's draft, the token's hash and the link's expiry; one event null → awaiting_approval by the principal; no delivery", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const [r] = await f.sql<Record<string, unknown>>(
        "SELECT status, question, agent_draft, approval_token_hash, approval_expires_at, not_sent_reason FROM requests WHERE id = $1",
        [a.id],
      );
      assert.equal(r!["status"], "awaiting_approval");
      assert.equal(r!["question"], ORIGINAL);
      assert.equal(r!["agent_draft"], ORIGINAL);
      assert.equal(r!["approval_token_hash"], await approvalTokenHash(a.token));
      assert.notEqual(r!["approval_token_hash"], a.token, "the token itself is never stored");
      assert.equal((r!["approval_expires_at"] as Date).toISOString(), "2026-10-28T09:00:00.000Z");
      assert.equal(r!["not_sent_reason"], null);
      assert.deepEqual(await events(f, a.id), [{ from_status: null, to_status: "awaiting_approval", actor: "principal" }]);
      assert.equal(await deliveries(f, a.id), 0);
    });
    test("a taken id is RequestIdTaken (the caller draws another); nothing half-written", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      await assert.rejects(awaiting(f, { id: a.id }), RequestIdTaken);
      assert.equal((await events(f, a.id)).length, 1);
    });
  });

  describe("awaiting_approval is never counted against the participant or the principal (D1)", () => {
    test("interruption budget, budget used and requests today ignore awaiting_approval and not_sent rows", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const b = await awaiting(f);
      assert.equal((await decideApproval(f.db, dontSend(b))).kind, "not_sent");
      const pid = (await findPublishedParticipant(f.db, "sim-mv-7f3c"))!.participant_id;
      const dayStart = new Date("2026-10-27T00:00:00Z");
      assert.equal(await countDeliveries(f.db, pid, dayStart, new Date(dayStart.getTime() + 86_400_000)), 0);
      assert.deepEqual(await principalUsage(f.db, PRINCIPAL, new Date("2026-10-01T00:00:00Z"), dayStart), { committed_minor: 0, requests_today: 0 });
      // Once sent it counts.
      assert.equal((await decideApproval(f.db, send(a))).kind, "sent");
      assert.equal(await countDeliveries(f.db, pid, dayStart, new Date(dayStart.getTime() + 86_400_000)), 1);
      assert.deepEqual(await principalUsage(f.db, PRINCIPAL, new Date("2026-10-01T00:00:00Z"), dayStart), { committed_minor: 3200, requests_today: 1 });
    });
    test("approvalFacts (the shared loader) reads rules, counts and budget as both apps need them", async () => {
      const f = await fresh();
      await awaiting(f);
      const participant = (await findPublishedParticipant(f.db, "sim-mv-7f3c"))!;
      const facts = await approvalFacts(f.db, {
        principal: { principal_id: PRINCIPAL, identity_mode: "real_name", verified: true },
        currency: "EUR",
        participant,
        now: NOW,
        approval: "recorded",
      });
      assert.equal(facts.now, NOW.toISOString());
      assert.equal(facts.interruptions_today, 0);
      assert.equal(facts.requests_today, 0);
      assert.deepEqual(facts.budget, { used_minor: 0, currency: "EUR" });
      assert.equal(facts.participant.handle, "sim-mv-7f3c");
      assert.equal(facts.approval, "recorded");
      assert.equal(facts.principal_throttled, false);
    });
  });

  describe("decideApproval (D4)", () => {
    test("Scenario: Send on the page: the request becomes sent with its event; delivery is left to the worker", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const out = await decideApproval(f.db, send(a));
      assert.equal(out.kind, "sent");
      if (out.kind === "sent") {
        assert.equal(out.deferred, false);
        assert.equal(out.deliver_at, LATER.toISOString());
        assert.equal(out.held_minor, 3200);
      }
      const r = await row(f, a.id);
      assert.equal(r.status, "sent");
      assert.equal(r.question, ORIGINAL);
      assert.equal(r.deliver_at.toISOString(), LATER.toISOString());
      assert.deepEqual((await events(f, a.id)).slice(1), [{ from_status: "awaiting_approval", to_status: "sent", actor: "principal" }]);
      assert.equal(await deliveries(f, a.id), 0, "nothing delivered inside the decision");
    });

    test("Scenario: Accept after editing: the request is sent with a question byte-identical to the edited text; the agent's draft is kept", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      assert.equal((await decideApproval(f.db, send(a, EDITED))).kind, "sent");
      const r = await row(f, a.id);
      assert.equal(r.question, EDITED);
      assert.equal(Buffer.compare(Buffer.from(r.question, "utf8"), Buffer.from(EDITED, "utf8")), 0);
      assert.equal(r.agent_draft, ORIGINAL);
    });

    test("Scenario: Don't send on the page: not_sent with reason declined, nothing held or delivered, the participant learns nothing", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      assert.deepEqual(await decideApproval(f.db, dontSend(a)), { kind: "not_sent", reason: "declined" });
      const r = await row(f, a.id);
      assert.equal(r.status, "not_sent");
      assert.equal(r.not_sent_reason, "declined");
      assert.deepEqual((await events(f, a.id)).slice(1), [{ from_status: "awaiting_approval", to_status: "not_sent", actor: "principal" }]);
      assert.equal(await deliveries(f, a.id), 0);
      const [b] = await f.sql<{ n: number }>("SELECT count(*)::int AS n FROM blocked_manifests");
      assert.equal(b!.n, 0);
    });

    test("Scenario: Edit turns the question into a push-poll: forbidden_content, nothing changes, the request stays awaiting_approval", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const out = await decideApproval(f.db, send(a, PUSH_POLL));
      assert.equal(out.kind, "invalid");
      if (out.kind === "invalid") {
        assert.equal(out.error.code, "forbidden_content");
        assert.ok(!JSON.stringify(out).includes(PUSH_POLL), "the question is not echoed");
      }
      const r = await row(f, a.id);
      assert.equal(r.status, "awaiting_approval");
      assert.equal(r.question, ORIGINAL);
      assert.equal((await events(f, a.id)).length, 1);
      // ...until a valid Send.
      assert.equal((await decideApproval(f.db, send(a))).kind, "sent");
    });

    test("Scenario: Budget spent meanwhile: over_budget, nothing held, stays awaiting_approval", async () => {
      const f = await fresh();
      const a = await awaiting(f, { manifest: { bid_minor: 5000 } });
      // Other requests (to another participant) use the budget between request_human and Send: 8 × 5800 sent.
      for (let i = 0; i < 8; i++) {
        const o = await awaiting(f, { manifest: { to: "sim-th-2a91", intent: "knowledge", bid_minor: 5800 } });
        assert.equal((await decideApproval(f.db, send(o))).kind, "sent", `other ${i}`);
      }
      const out = await decideApproval(f.db, send(a));
      assert.equal(out.kind === "invalid" && out.error.code, "over_budget");
      assert.equal((await row(f, a.id)).status, "awaiting_approval");
    });

    test("participant rules changed meanwhile: outside_participant_rules, counted for the participant with the request id, stays awaiting_approval", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const pid = (await findPublishedParticipant(f.db, "sim-mv-7f3c"))!.participant_id;
      await f.sql("UPDATE rule_types SET accepted = false WHERE participant_id = $1 AND intent = 'judgment'", [pid]);
      const out = await decideApproval(f.db, send(a));
      assert.equal(out.kind === "invalid" && out.error.code, "outside_participant_rules");
      assert.equal((await row(f, a.id)).status, "awaiting_approval");
      const blocked = await f.sql<{ request_id: string; code: string }>("SELECT request_id, code FROM blocked_manifests");
      assert.deepEqual(blocked, [{ request_id: a.id, code: "type_not_accepted" }]);
    });

    test("Scenario: Decision replayed: Send or Don't send on a decided request changes nothing and reports the decision taken", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      assert.equal((await decideApproval(f.db, send(a))).kind, "sent");
      for (const again of [send(a), send(a, EDITED), dontSend(a)]) {
        const out = await decideApproval(f.db, again);
        assert.equal(out.kind, "already_decided");
        if (out.kind === "already_decided") {
          assert.equal(out.status, "sent");
          assert.equal(out.decided_at, LATER.toISOString());
        }
      }
      assert.equal((await events(f, a.id)).length, 2, "no second transition");
      assert.equal((await row(f, a.id)).question, ORIGINAL);
    });

    test("Scenario: Forged token: the same answer as for an unknown request, nothing revealed, nothing changed", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const forged = formatApprovalToken(new Uint8Array(32).fill(7));
      assert.deepEqual(await decideApproval(f.db, send(a, ORIGINAL, { token: forged })), { kind: "link_invalid" });
      assert.deepEqual(await decideApproval(f.db, { ...send(a), request_id: "A2H-ffff" }), { kind: "link_invalid" });
      assert.deepEqual(await decideApproval(f.db, send(a, ORIGINAL, { token: "not a token" })), { kind: "link_invalid" });
      assert.equal((await row(f, a.id)).status, "awaiting_approval");
    });

    test("Scenario: Another principal opens the link: wrong_principal, nothing about the request, nothing changed", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      for (const d of [send(a, ORIGINAL, { principal_id: OTHER }), dontSend(a, { principal_id: OTHER })]) {
        assert.deepEqual(await decideApproval(f.db, d), { kind: "wrong_principal" });
      }
      assert.equal((await row(f, a.id)).status, "awaiting_approval");
      assert.equal((await events(f, a.id)).length, 1);
    });

    test("Scenario: Link expires unused (page side): a decision after the link's expiry sends nothing and the request becomes not_sent, expired", async () => {
      const f = await fresh();
      const a = await awaiting(f, { expiresAt: new Date(NOW.getTime() + 30 * 60_000) });
      const late = new Date(NOW.getTime() + 31 * 60_000);
      assert.deepEqual(await decideApproval(f.db, send(a, ORIGINAL, { now: late })), { kind: "expired" });
      const r = await row(f, a.id);
      assert.equal(r.status, "not_sent");
      assert.equal(r.not_sent_reason, "expired");
      assert.deepEqual((await events(f, a.id)).slice(1), [{ from_status: "awaiting_approval", to_status: "not_sent", actor: "platform" }]);
      // Opening it again shows that it expired.
      assert.deepEqual(await decideApproval(f.db, dontSend(a, { now: late })), { kind: "expired" });
    });

    test("two concurrent decisions produce one transition (FOR UPDATE)", async () => {
      const f = await fresh();
      for (let round = 0; round < 5; round++) {
        const a = await awaiting(f);
        const outcomes = await Promise.all([decideApproval(f.db, send(a)), decideApproval(f.db, round % 2 ? dontSend(a) : send(a, EDITED))]);
        const kinds = outcomes.map((o) => o.kind).sort();
        assert.equal(kinds.filter((k) => k === "already_decided").length, 1, JSON.stringify(kinds));
        assert.equal((await events(f, a.id)).length, 2, "exactly one transition out of awaiting_approval");
      }
    });
  });

  describe("expireApproval (D6)", () => {
    test("Scenario: Approval link expiry by the platform: past its expiry an awaiting request becomes not_sent, expired, by the platform; before it, nothing; twice, once", async () => {
      const f = await fresh();
      const a = await awaiting(f, { expiresAt: new Date(NOW.getTime() + 60_000) });
      assert.equal(await expireApproval(f.db, a.id, NOW), false, "not due yet");
      assert.equal((await row(f, a.id)).status, "awaiting_approval");
      const due = new Date(NOW.getTime() + 60_000);
      assert.equal(await expireApproval(f.db, a.id, due), true);
      assert.equal(await expireApproval(f.db, a.id, due), false, "idempotent");
      const r = await row(f, a.id);
      assert.equal(r.status, "not_sent");
      assert.equal(r.not_sent_reason, "expired");
      assert.equal((await events(f, a.id)).length, 2);
      assert.equal(await deliveries(f, a.id), 0, "no delivery ever existed");
    });
    test("a decided request is never expired by the approval job", async () => {
      const f = await fresh();
      const a = await awaiting(f, { expiresAt: new Date(NOW.getTime() + 60_000) });
      assert.equal((await decideApproval(f.db, send(a, ORIGINAL, { now: NOW }))).kind, "sent");
      assert.equal(await expireApproval(f.db, a.id, LATER), false);
      assert.equal((await row(f, a.id)).status, "sent");
    });
  });
});
