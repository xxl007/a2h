// Task 3.1 against PostgreSQL 17 in Docker: the generated migrations apply
// cleanly into a stage schema, and the constraints hold at the database level.
// Specs: protocol/request-approval "Blocked row"; protocol/request-lifecycle
// "Closed status set", "Illegal transition", "Idempotent replay";
// protocol/answer-attestation "Envelope is complete or rejected", "Revoked
// key"; platform/participant-simulation "Simulation is unmistakable".
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate, skipWithoutDocker, startPostgres, type PgContainer } from "./lib/postgres.ts";

const skip = skipWithoutDocker();
const SCHEMA = "pr_7";
const SIG = "A".repeat(86) + "==";
const PUB = "B".repeat(43) + "=";
const PUB2 = "C".repeat(43) + "=";

let pgc: PgContainer;
let db: pg.Client;

/** Runs `sql` in a savepoint; returns the error message, or null on success. */
async function attempt(sql: string, params: unknown[] = []): Promise<string | null> {
  await db.query("SAVEPOINT s");
  try {
    await db.query(sql, params);
    await db.query("RELEASE SAVEPOINT s");
    return null;
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT s");
    return (e as Error).message;
  }
}
async function rejects(sql: string, params: unknown[] = [], pattern?: RegExp): Promise<void> {
  const err = await attempt(sql, params);
  assert.notEqual(err, null, `accepted: ${sql} ${JSON.stringify(params)}`);
  if (pattern) assert.match(err!, pattern);
}
async function accepts(sql: string, params: unknown[] = []): Promise<void> {
  assert.equal(await attempt(sql, params), null);
}

describe("database constraints (Postgres 17)", { skip }, () => {
  before(async () => {
    pgc = await startPostgres();
    db = new pg.Client({ connectionString: pgc.url });
    await db.connect();
    await migrate(db, SCHEMA);
    await db.query(`SET search_path = ${SCHEMA}`);
    // One transaction for the whole suite: each case runs in a savepoint.
    await db.query("BEGIN");
    await db.query(`INSERT INTO simulated_personas (persona, delay_seconds, decline_reason_code) VALUES
      ('prompt', 20, NULL), ('decline', 15, 'outside_expertise')`);
    await db.query(`INSERT INTO participants (id, handle, display_label, simulated, persona) VALUES
      ('p_sim_mv', 'sim-mv-7f3c', 'Margaret Vale (simulated)', true, 'prompt')`);
    await db.query(`INSERT INTO signing_keys (key_id, public_key, status) VALUES ('stage-pr-7-1', $1, 'active')`, [PUB]);
    await db.query(`INSERT INTO requests (id, principal_id, participant_id, intent, audience, time_shape, format, lane,
        question, bid_minor, currency, expires_at, deliver_at, data_terms)
      VALUES ('A2H-7f3c', 'dev-principal-pr-7', 'p_sim_mv', 'judgment', 'named_individual', 'one_shot', 'single_field', 'paid',
        'Is this leaflet alarming?', 3500, 'EUR', now() + interval '1 day', now(), '{"storage":"principal_workspace","attribution":"not_attributed","training":"off"}')`);
    await db.query(`INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ('A2H-7f3c', NULL, 'sent', 'principal')`);
  });
  after(async () => {
    await db?.query("ROLLBACK").catch(() => undefined);
    await db?.end().catch(() => undefined);
    pgc?.stop();
  });

  test("migrations applied into the stage schema only; public holds nothing", async () => {
    const { rows } = await db.query(
      `SELECT n.nspname AS schema, count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','S','i') AND n.nspname IN ('public', $1) GROUP BY 1 ORDER BY 1`, [SCHEMA]);
    assert.deepEqual(rows.map((r: { schema: string }) => r.schema), [SCHEMA]);
    const tables = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY 1`, [SCHEMA]);
    assert.deepEqual(tables.rows.map((r: { tablename: string }) => r.tablename), [
      "answers", "blocked_manifests", "participants", "profiles", "request_deliveries", "request_events", "requests", "rule_types",
      "rules", "schema_migrations", "signing_keys", "simulated_personas",
    ]);
  });

  describe("Scenario: Blocked row", () => {
    const insert = `INSERT INTO blocked_manifests (request_id, participant_id, principal_id, stage, code) VALUES ($1, $2, $3, $4, $5)`;
    test("a row with ids, stage, code and time is accepted", async () => {
      await accepts(insert, [null, "p_sim_mv", "dev-principal-pr-7", "rules", "bid_below_reserve"]);
      const { rows } = await db.query<{ at: unknown }>(`SELECT at FROM blocked_manifests`);
      assert.ok(rows[0]?.at instanceof Date, "time recorded by default");
    });
    test("no column holds text: the question in the code column is refused", async () => {
      await rejects(insert, [null, "p_sim_mv", "dev-principal-pr-7", "rules", "Is this leaflet alarming?"]);
    });
    test("no column holds text: an unknown code, a long string in an id column, another stage", async () => {
      await rejects(insert, [null, "p_sim_mv", "dev-principal-pr-7", "rules", "over_budget"]);
      await rejects(insert, [null, "p_sim_mv", "Is this patient-information leaflet alarming for a newly diagnosed reader?", "rules", "quiet_hours"]);
      await rejects(insert, [null, "p_sim_mv", "dev principal with spaces", "rules", "quiet_hours"]);
      await rejects(insert, ["not a request id", "p_sim_mv", "dev-principal-pr-7", "rules", "quiet_hours"]);
      await rejects(insert, [null, "p_sim_mv", "dev-principal-pr-7", "content", "quiet_hours"]);
    });
    test("a question column does not exist", async () => {
      await rejects(`INSERT INTO blocked_manifests (participant_id, principal_id, stage, code, question) VALUES ('p_sim_mv','x','rules','quiet_hours','q')`, [], /column "question"/);
    });
    test("append-only: no update, no delete", async () => {
      await rejects(`UPDATE blocked_manifests SET code = 'quiet_hours'`, [], /append-only/);
      await rejects(`DELETE FROM blocked_manifests`, [], /append-only/);
      await rejects(`TRUNCATE blocked_manifests`, [], /append-only/);
    });
  });

  describe("request deliveries (task 5.2: delivered once, counted for the interruption budget)", () => {
    const ins = `INSERT INTO request_deliveries (request_id, participant_id, outcome) VALUES ($1, $2, $3)`;
    test("one row per request, outcome delivered or blocked only", async () => {
      await rejects(ins, ["A2H-7f3c", "p_sim_mv", "sent"]);
      await rejects(ins, ["A2H-7f3c", "p_sim_mv", "Is this leaflet alarming?"]);
      await rejects(ins, ["A2H-0000", "p_sim_mv", "delivered"], /foreign key/);
      await db.query("SAVEPOINT d");
      await accepts(ins, ["A2H-7f3c", "p_sim_mv", "delivered"]);
      await rejects(ins, ["A2H-7f3c", "p_sim_mv", "blocked"], /duplicate key/);
      await db.query("ROLLBACK TO SAVEPOINT d");
    });
    test("append-only: no update, no delete", async () => {
      await db.query("SAVEPOINT d");
      await accepts(ins, ["A2H-7f3c", "p_sim_mv", "blocked"]);
      await rejects(`UPDATE request_deliveries SET outcome = 'delivered'`, [], /append-only/);
      await rejects(`DELETE FROM request_deliveries`, [], /append-only/);
      await rejects(`TRUNCATE request_deliveries`, [], /append-only/);
      await db.query("ROLLBACK TO SAVEPOINT d");
    });
  });

  describe("Accepted approval replayed: an approval nonce creates one request only", () => {
    const N1 = "0123456789abcdef0123456789abcdef";
    const ins = (id: string, nonce: string | null): [string, unknown[]] => [
      `INSERT INTO requests (id, principal_id, participant_id, intent, audience, time_shape, format, lane,
          question, bid_minor, currency, expires_at, deliver_at, data_terms, approval_nonce)
        VALUES ($1, 'dev-principal-pr-7', 'p_sim_mv', 'judgment', 'named_individual', 'one_shot', 'single_field', 'paid',
          'Is this leaflet alarming?', 3500, 'EUR', now() + interval '1 day', now(), '{}', $2)`,
      [id, nonce],
    ];
    test("a nonce is used by at most one request", async () => {
      await db.query("SAVEPOINT n");
      await accepts(...ins("A2H-0a01", N1));
      await rejects(...ins("A2H-0a02", N1), /requests_approval_nonce_unique/);
      await db.query("ROLLBACK TO SAVEPOINT n");
    });
    test("requests without a nonce (none recorded) do not collide", async () => {
      await db.query("SAVEPOINT n");
      await accepts(...ins("A2H-0b01", null));
      await accepts(...ins("A2H-0b02", null));
      await db.query("ROLLBACK TO SAVEPOINT n");
    });
    test("the nonce is 32 lower-case hex characters, never text", async () => {
      for (const bad of ["0123456789ABCDEF0123456789ABCDEF", "0123", "Is this leaflet alarming? yes it", `${N1}0`]) {
        await rejects(...ins("A2H-0c01", bad));
      }
    });
  });

  describe("request lifecycle", () => {
    const ev = `INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ('A2H-7f3c', $1, $2, $3)`;
    test("Closed status set: a status outside the set is refused", async () => {
      await rejects(`UPDATE requests SET status = 'done' WHERE id = 'A2H-7f3c'`);
      await rejects(ev, ["sent", "done", "participant"]);
    });
    test("Legal transitions: sent → accepted by the participant writes one event row", async () => {
      await accepts(ev, ["sent", "accepted", "participant"]);
    });
    test("Illegal transition: answered → accepted, declined → accepted, sent → answered, wrong actor", async () => {
      await rejects(ev, ["answered", "accepted", "participant"]);
      await rejects(ev, ["declined", "accepted", "participant"]);
      await rejects(ev, ["sent", "answered", "participant"]);
      await rejects(ev, ["sent", "declined", "platform"]);
      await rejects(ev, ["accepted", "expired", "participant"]);
      await rejects(ev, [null, "accepted", "participant"]);
    });
    test("Idempotent replay: a second event with the same target state is refused (no second row)", async () => {
      await rejects(ev, ["sent", "accepted", "participant"], /request_events_request_to_unique|duplicate key/);
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM request_events WHERE to_status = 'accepted'`);
      assert.equal(rows[0]?.n, 1);
    });
    test("a reason code goes with a decline only, and is a short code", async () => {
      await rejects(`INSERT INTO request_events (request_id, from_status, to_status, actor, reason_code) VALUES ('A2H-7f3c', 'accepted', 'expired', 'platform', 'late')`);
      await rejects(`INSERT INTO request_events (request_id, from_status, to_status, actor, reason_code) VALUES ('A2H-7f3c', 'sent', 'declined', 'participant', 'I am too busy this week, sorry')`);
    });
    test("append-only: request events are never updated or deleted", async () => {
      await rejects(`UPDATE request_events SET actor = 'platform'`, [], /append-only/);
      await rejects(`DELETE FROM request_events`, [], /append-only/);
      await rejects(`TRUNCATE request_events`, [], /append-only/);
    });
    test("requests: ids, money and currency are constrained", async () => {
      await rejects(`UPDATE requests SET bid_minor = -1`);
      await rejects(`UPDATE requests SET currency = 'eur'`);
      await rejects(`UPDATE requests SET cleared_minor = 3600`, [], /requests_cleared/);
      await rejects(`UPDATE requests SET cleared_minor = 3000`, [], /requests_cleared/);
      await rejects(`UPDATE requests SET question = ''`);
      await rejects(`UPDATE requests SET question = repeat('x', 2001)`);
      await rejects(`UPDATE requests SET lane = 'free'`);
      await rejects(`INSERT INTO requests (id, principal_id, participant_id, intent, audience, time_shape, format, lane, question, bid_minor, currency, expires_at, deliver_at, data_terms)
        SELECT 'A2H-7F3C', principal_id, participant_id, intent, audience, time_shape, format, lane, question, bid_minor, currency, expires_at, deliver_at, data_terms FROM requests`);
    });
  });

  describe("answers (Envelope is complete or rejected)", () => {
    const insert = `INSERT INTO answers (request_id, participant_id, body, confidence, answered_personally, signed_at, key_id, signature)
      VALUES ('A2H-7f3c', 'p_sim_mv', '{"verdict":"yes"}', $1, $2, $3, $4, $5)`;
    const ok = [4, true, "2026-10-21T09:10:00+02:00", "stage-pr-7-1", SIG];
    test("attestation false or missing is refused", async () => {
      await rejects(insert, [4, false, ...ok.slice(2)]);
      await rejects(insert, [4, null, ...ok.slice(2)]);
    });
    test("confidence 0 or 6 is refused", async () => {
      await rejects(insert, [0, ...ok.slice(1)]);
      await rejects(insert, [6, ...ok.slice(1)]);
    });
    test("unsigned, malformed signature, unknown key are refused", async () => {
      await rejects(insert, [...ok.slice(0, 4), null]);
      await rejects(insert, [...ok.slice(0, 4), "a2h:sig:…c91e"]);
      await rejects(insert, [...ok.slice(0, 3), "unknown-key", SIG]);
      await rejects(insert, [4, true, "21 Oct 2026", "stage-pr-7-1", SIG]);
    });
    test("signed_at is stored verbatim, as signed (the canonical payload is recomputed from it)", async () => {
      await accepts(insert, ok);
      const { rows } = await db.query<{ signed_at: string }>(`SELECT signed_at FROM answers`);
      assert.equal(rows[0]?.signed_at, "2026-10-21T09:10:00+02:00");
    });
    test("append-only: an answer is never updated or deleted; one answer per request", async () => {
      await rejects(`UPDATE answers SET confidence = 5`, [], /append-only/);
      await rejects(`DELETE FROM answers`, [], /append-only/);
      await rejects(insert, ok, /duplicate key/);
    });
  });

  describe("signing keys (Old key still verifies, Revoked key)", () => {
    test("one active key per owner", async () => {
      await rejects(`INSERT INTO signing_keys (key_id, public_key, status) VALUES ('stage-pr-7-2', $1, 'active')`, [PUB2], /signing_keys_one_active/);
    });
    test("rotation: active → rotated, then a new active key; the rotated key keeps its public key", async () => {
      await accepts(`UPDATE signing_keys SET status = 'rotated', rotated_at = now() WHERE key_id = 'stage-pr-7-1'`);
      await accepts(`INSERT INTO signing_keys (key_id, public_key, status) VALUES ('stage-pr-7-2', $1, 'active')`, [PUB2]);
      await rejects(`UPDATE signing_keys SET public_key = $1 WHERE key_id = 'stage-pr-7-1'`, [PUB2], /immutable/);
    });
    test("a key never comes back: rotated → active and revoked → anything are refused", async () => {
      await rejects(`UPDATE signing_keys SET status = 'active', rotated_at = NULL WHERE key_id = 'stage-pr-7-1'`, [], /signing key/);
      await accepts(`UPDATE signing_keys SET status = 'revoked', revoked_at = now() WHERE key_id = 'stage-pr-7-1'`);
      await rejects(`UPDATE signing_keys SET status = 'rotated', revoked_at = NULL WHERE key_id = 'stage-pr-7-1'`, [], /signing key/);
      await rejects(`DELETE FROM signing_keys WHERE key_id = 'stage-pr-7-1'`, [], /signing key/);
    });
    test("status and timestamps agree; public key is base64 of 32 bytes", async () => {
      await rejects(`INSERT INTO signing_keys (key_id, public_key, status) VALUES ('k3', $1, 'revoked')`, ["D".repeat(43) + "="]);
      await rejects(`INSERT INTO signing_keys (key_id, public_key, status) VALUES ('k4', 'not-a-key', 'rotated')`);
    });
  });

  describe("Simulation is unmistakable", () => {
    const insert = `INSERT INTO participants (id, handle, display_label, simulated, persona) VALUES ($1, $2, $3, $4, $5)`;
    test("a sim- handle must be simulated, labelled '(simulated)' and have a persona", async () => {
      await rejects(insert, ["p2", "sim-ab-1234", "Ann Bright (simulated)", false, null]);
      await rejects(insert, ["p2", "sim-ab-1234", "Ann Bright", true, "prompt"]);
      await rejects(insert, ["p2", "sim-ab-1234", "Ann Bright (simulated)", true, null]);
      await accepts(insert, ["p2", "sim-ab-1234", "Ann Bright (simulated)", true, "prompt"]);
    });
    test("a real participant has no sim- handle, no '(simulated)' label and no persona", async () => {
      await rejects(insert, ["p3", "ab-1234", "Ann Bright", true, "prompt"]);
      await rejects(insert, ["p3", "ab-1234", "Ann Bright (simulated)", false, null]);
      await rejects(insert, ["p3", "ab-1234", "Ann Bright", false, "prompt"]);
      await accepts(insert, ["p3", "ab-1234", "Ann Bright", false, null]);
    });
    test("handles follow the protocol pattern", async () => {
      await rejects(insert, ["p4", "Sim-AB-1234", "X (simulated)", true, "prompt"]);
    });
    test("persona delays stay under two minutes; only the decline persona carries a reason", async () => {
      await rejects(`INSERT INTO simulated_personas (persona, delay_seconds) VALUES ('slow', 120)`);
      await rejects(`INSERT INTO simulated_personas (persona, delay_seconds) VALUES ('chatty', 10)`);
      await rejects(`INSERT INTO simulated_personas (persona, delay_seconds, decline_reason_code) VALUES ('slow', 90, 'outside_expertise')`);
      await accepts(`INSERT INTO simulated_personas (persona, delay_seconds) VALUES ('slow', 90)`);
    });
  });
});
