// Task 3.1 against PostgreSQL 17 in Docker: the generated migrations apply
// cleanly into a stage schema, and the constraints hold at the database level.
// Specs: protocol/request-approval "Blocked row"; protocol/request-lifecycle
// "Closed status set", "Illegal transition", "Idempotent replay";
// protocol/answer-attestation "Envelope is complete or rejected", "Revoked
// key"; platform/participant-simulation "Simulation is unmistakable".
// m1-hosted-connector group 3 (design D4, D5): principals, their policies and
// the per-principal rate-limit windows.
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
      "account", "answers", "blocked_manifests", "jwks", "oauth_access_token", "oauth_client", "oauth_client_assertion",
      "oauth_client_resource", "oauth_consent", "oauth_refresh_token", "oauth_resource", "participants", "principal_policies",
      "principals", "profiles", "rate_limit_windows", "request_deliveries", "request_events", "requests", "rule_types", "rules",
      "schema_migrations", "session", "signing_keys", "simulated_personas", "user", "verification",
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

  describe("principals and their policies (m1-hosted-connector design D4)", () => {
    const P = "u_8Yw2kQ1rT5zX0aBcD3eF6gH";
    const insPrincipal = `INSERT INTO principals (principal_id, identity_mode, verified) VALUES ($1, $2, $3)`;
    const insPolicy = `INSERT INTO principal_policies (principal_id, currency, monthly_budget_minor, per_request_cap_minor,
        ask_first_above_minor, daily_request_limit, throttled_daily_limit) VALUES ($1, $2, $3, $4, $5, $6, $7)`;
    const policy = (over: Partial<Record<string, unknown>> = {}): unknown[] => {
      const v = { currency: "EUR", monthly: 50000, cap: 6000, ask: null as number | null, daily: 50, throttled: 5, ...over };
      return [P, v.currency, v.monthly, v.cap, v.ask, v.daily, v.throttled];
    };
    test("a principal defaults to real_name, not verified, with a creation time", async () => {
      await db.query("SAVEPOINT p");
      await accepts(`INSERT INTO principals (principal_id) VALUES ($1)`, [P]);
      const { rows } = await db.query<{ identity_mode: string; verified: boolean; created_at: unknown }>(`SELECT identity_mode, verified, created_at FROM principals WHERE principal_id = $1`, [P]);
      assert.equal(rows[0]?.identity_mode, "real_name");
      assert.equal(rows[0]?.verified, false);
      assert.ok(rows[0]?.created_at instanceof Date);
      await db.query("ROLLBACK TO SAVEPOINT p");
    });
    test("principal id is unique", async () => {
      await db.query("SAVEPOINT p");
      await accepts(insPrincipal, [P, "real_name", false]);
      await rejects(insPrincipal, [P, "verified_organisation", true], /principals_pkey|duplicate key/);
      await db.query("ROLLBACK TO SAVEPOINT p");
    });
    test("principal id is an opaque id (no e-mail address, no spaces, at most 64 characters); identity mode is the protocol's", async () => {
      await rejects(insPrincipal, ["ana@example.org", "real_name", false]);
      await rejects(insPrincipal, ["has spaces", "real_name", false]);
      await rejects(insPrincipal, ["x".repeat(65), "real_name", false]);
      await rejects(insPrincipal, [P, "anonymous", false]);
    });
    describe("policy", () => {
      before(async () => {
        await db.query(insPrincipal, [P, "real_name", false]);
      });
      test("the stage default is accepted, ask_first_above_minor may be null (every request asks first)", async () => {
        await db.query("SAVEPOINT q");
        await accepts(insPolicy, policy());
        const { rows } = await db.query<{ ask_first_above_minor: number | null; updated_at: unknown }>(`SELECT ask_first_above_minor, updated_at FROM principal_policies WHERE principal_id = $1`, [P]);
        assert.equal(rows[0]?.ask_first_above_minor, null);
        assert.ok(rows[0]?.updated_at instanceof Date);
        await rejects(insPolicy, policy(), /principal_policies_pkey|duplicate key/);
        await db.query("ROLLBACK TO SAVEPOINT q");
      });
      test("one policy per known principal: an unknown principal is refused", async () => {
        await rejects(insPolicy, ["u_nobody", "EUR", 1, 1, null, 1, 1], /foreign key/);
      });
      test("money columns refuse negatives and fractions; limits refuse negatives", async () => {
        await rejects(insPolicy, policy({ monthly: -1 }));
        await rejects(insPolicy, policy({ cap: -1 }));
        await rejects(insPolicy, policy({ ask: -1 }));
        await rejects(insPolicy, policy({ daily: -1 }));
        await rejects(insPolicy, policy({ throttled: -1 }));
        await rejects(insPolicy, policy({ monthly: 500.5 }));
        await rejects(insPolicy, policy({ cap: "60.00" }));
      });
      test("currency is three upper-case letters", async () => {
        await rejects(insPolicy, policy({ currency: "eur" }));
        await rejects(insPolicy, policy({ currency: "EU" }));
      });
      test("zero is a valid amount and a valid limit", async () => {
        await db.query("SAVEPOINT q");
        await accepts(insPolicy, policy({ monthly: 0, cap: 0, ask: 0, daily: 0, throttled: 0 }));
        await db.query("ROLLBACK TO SAVEPOINT q");
      });
    });
  });

  describe("rate-limit windows (m1-hosted-connector design D5)", () => {
    const P = "u_rl_1";
    const ins = `INSERT INTO rate_limit_windows (principal_id, window_kind, window_start, count) VALUES ($1, $2, $3, $4)`;
    before(async () => {
      await db.query(`INSERT INTO principals (principal_id) VALUES ($1)`, [P]);
    });
    test("one row per (principal, window kind, window start): a duplicate is refused", async () => {
      await db.query("SAVEPOINT r");
      await accepts(ins, [P, "minute", "2026-10-27T09:00:00Z", 1]);
      await accepts(ins, [P, "day", "2026-10-27T00:00:00Z", 1]);
      await accepts(ins, [P, "minute", "2026-10-27T09:01:00Z", 1]);
      await rejects(ins, [P, "minute", "2026-10-27T09:00:00Z", 1], /rate_limit_windows_pkey|duplicate key/);
      await db.query("ROLLBACK TO SAVEPOINT r");
    });
    test("window kind is minute or day; count is a non-negative integer", async () => {
      await rejects(ins, [P, "hour", "2026-10-27T09:00:00Z", 1]);
      await rejects(ins, [P, "minute", "2026-10-27T09:00:00Z", -1]);
      await rejects(ins, [P, "minute", "2026-10-27T09:00:00Z", 1.5]);
    });
    test("a window starts on its UTC boundary, so every instance computes the same key", async () => {
      await rejects(ins, [P, "minute", "2026-10-27T09:00:30Z", 1]);
      await rejects(ins, [P, "minute", "2026-10-27T09:00:00.001Z", 1]);
      await rejects(ins, [P, "day", "2026-10-27T09:00:00Z", 1]);
      await rejects(ins, [P, "day", "2026-10-27T00:00:00+02:00", 1]);
    });
    test("an unknown principal is refused", async () => {
      await rejects(ins, ["u_nobody", "minute", "2026-10-27T09:00:00Z", 1], /foreign key/);
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
