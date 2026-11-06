// Migration 0010 against PostgreSQL 17 (m2-approval-page task 3.1, design
// D5): the m1 approval path goes. On a stage that already holds m1 requests
// (created straight into `sent`, with an approval nonce) the migration
// applies, their history stays as it is, and from then on a request can only
// be created into awaiting_approval.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate, skipWithoutDocker, startPostgres, type PgContainer } from "./lib/postgres.ts";

const skip = skipWithoutDocker();
const SCHEMA = "pr_m1rows";
const DROP = "0010_requests_drop_m1_approval.sql";

let pgc: PgContainer;
let client: pg.Client;

describe("migration 0010 on a stage with m1 requests (Postgres 17)", { skip }, () => {
  before(async () => {
    pgc = await startPostgres();
    client = new pg.Client({ connectionString: pgc.url });
    await client.connect();
    await migrate(client, SCHEMA, (f) => f < DROP);
    await client.query(`SET search_path = ${SCHEMA}`);
    await client.query(`INSERT INTO participants (id, handle, display_label, simulated) VALUES ('p_x', 'xx-0001', 'X', false)`);
    await client.query(`INSERT INTO requests (id, principal_id, participant_id, intent, audience, time_shape, format, lane,
        question, bid_minor, currency, expires_at, deliver_at, data_terms, status, approval_nonce)
      VALUES ('A2H-0001', 'u_m1', 'p_x', 'judgment', 'named_individual', 'one_shot', 'single_field', 'paid',
        'Is this leaflet alarming?', 3500, 'EUR', now() + interval '1 day', now(), '{}', 'sent', '0123456789abcdef0123456789abcdef')`);
    await client.query(`INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ('A2H-0001', NULL, 'sent', 'principal')`);
    await client.query(`RESET search_path`);
    await migrate(client, SCHEMA, (f) => f >= DROP);
    await client.query(`SET search_path = ${SCHEMA}`);
  });
  after(async () => {
    await client?.end().catch(() => undefined);
    pgc?.stop();
  });

  test("applies over m1 rows; their request and creation event are kept", async () => {
    const { rows } = await client.query(`SELECT r.status, e.from_status, e.to_status FROM requests r JOIN request_events e ON e.request_id = r.id WHERE r.id = 'A2H-0001'`);
    assert.deepEqual(rows, [{ status: "sent", from_status: null, to_status: "sent" }]);
  });
  test("the approval nonce column is gone", async () => {
    const { rows } = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'requests' AND column_name = 'approval_nonce'`, [SCHEMA]);
    assert.equal(rows.length, 0);
  });
  test("a new creation event straight into sent is refused; into awaiting_approval it is accepted", async () => {
    await client.query(`INSERT INTO requests (id, principal_id, participant_id, intent, audience, time_shape, format, lane,
        question, bid_minor, currency, expires_at, deliver_at, data_terms, status)
      SELECT 'A2H-0002', principal_id, participant_id, intent, audience, time_shape, format, lane, question, bid_minor, currency, expires_at, deliver_at, data_terms, 'sent' FROM requests WHERE id = 'A2H-0001'`);
    await assert.rejects(client.query(`INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ('A2H-0002', NULL, 'sent', 'principal')`), /request_events_legal/);
    await client.query(`INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ('A2H-0002', NULL, 'awaiting_approval', 'principal')`);
  });
});
