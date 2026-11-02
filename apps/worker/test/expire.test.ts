// Task 5.4: the scheduled `expire` queue. Spec request-lifecycle "Expiry by
// the platform" and "Idempotent replay".
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { holdStatusAfter } from "@a2h/protocol";
import { createPool } from "../src/db.ts";
import { expireDue } from "../src/expire.ts";
import type { WorkerLogLine } from "../src/log.ts";
import { createRequest, eventsOf, statusOf } from "./lib/requests.ts";
import { PRINCIPAL_ID, skipWithoutDocker, startStageDb, testConfig, type StageDb } from "./lib/stage-db.ts";

const skip = skipWithoutDocker();

describe("expire", { skip }, () => {
  let stage: StageDb;
  let pool: pg.Pool;
  let logs: WorkerLogLine[] = [];
  const at = (offsetSeconds: number) => () => new Date(Date.now() + offsetSeconds * 1000);
  const ctx = (now = at(0)) => ({ pool, config: testConfig(stage.db), log: (l: WorkerLogLine) => logs.push(l), now });

  before(async () => {
    stage = await startStageDb();
    pool = createPool(stage.db);
  });
  after(async () => {
    await pool?.end();
    await stage?.stop();
  });

  test("Scenario: Expiry by the platform", async () => {
    const sent = await createRequest(stage.admin, { handle: "sim-hb-1f7d", intent: "judgment", bid_minor: 4400, expires_in: 60 });
    const accepted = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500, expires_in: 60, status: "accepted" });
    const later = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500, expires_in: 3600 });
    // Before the expiry time nothing changes.
    await expireDue(ctx());
    assert.equal(await statusOf(stage.admin, sent.id), "sent");
    // At the expiry time: expired, by the platform, one event row each.
    logs = [];
    await expireDue(ctx(at(61)));
    for (const [r, from] of [[sent, "sent"], [accepted, "accepted"]] as const) {
      assert.equal(await statusOf(stage.admin, r.id), "expired");
      assert.deepEqual((await eventsOf(stage.admin, r.id)).at(-1), { from_status: from, to_status: "expired", actor: "platform", reason_code: null });
    }
    assert.equal(await statusOf(stage.admin, later.id), "sent", "not yet due");
    // Its held amount is reported as released.
    assert.equal(holdStatusAfter("expired", { paid: true }), "released");
    const lines = logs.filter((l) => l.msg === "request expired");
    assert.deepEqual(lines.map((l) => l.request_id).sort(), [sent.id, accepted.id].sort());
    assert.ok(!JSON.stringify(logs).includes("leaflet"), "no question text in logs");
  });

  test("Scenario: Idempotent replay (expiry applied twice, also concurrently)", async () => {
    const r = await createRequest(stage.admin, { handle: "sim-bk-2e6f", intent: "knowledge", bid_minor: 4000, expires_in: 30 });
    await Promise.all([expireDue(ctx(at(31))), expireDue(ctx(at(31)))]);
    await expireDue(ctx(at(31)));
    const events = await eventsOf(stage.admin, r.id);
    assert.equal(events.filter((e) => e.to_status === "expired").length, 1, JSON.stringify(events));
    assert.equal(await statusOf(stage.admin, r.id), "expired");
  });

  test("terminal requests past their expiry are left alone", async () => {
    const r = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500, expires_in: 30, status: "accepted" });
    await stage.admin.query(`UPDATE requests SET status = 'declined' WHERE id = $1`, [r.id]);
    await expireDue(ctx(at(31)));
    assert.equal(await statusOf(stage.admin, r.id), "declined");
    assert.equal((await eventsOf(stage.admin, r.id)).filter((e) => e.to_status === "expired").length, 0);
  });

  // m1-hosted-connector task 7.3 (design D5): the expiry job prunes the rate-limit windows older than a day.
  test("the expiry run deletes rate-limit windows that started more than a day ago, and keeps the others", async () => {
    const now = new Date("2026-10-28T12:00:30Z");
    await stage.admin.query(
      `INSERT INTO rate_limit_windows (principal_id, window_kind, window_start, count) VALUES
         ($1, 'minute', '2026-10-27T11:59:00Z', 3), ($1, 'day', '2026-10-27T00:00:00Z', 9),
         ($1, 'minute', '2026-10-28T12:00:00Z', 1), ($1, 'day', '2026-10-28T00:00:00Z', 1)`,
      [PRINCIPAL_ID],
    );
    logs = [];
    await expireDue(ctx(() => now));
    const left = await stage.admin.query<{ window_kind: string; window_start: Date }>(`SELECT window_kind, window_start FROM rate_limit_windows ORDER BY window_start`);
    assert.deepEqual(
      left.rows.map((r) => [r.window_kind, r.window_start.toISOString()]),
      [
        ["day", "2026-10-28T00:00:00.000Z"],
        ["minute", "2026-10-28T12:00:00.000Z"],
      ],
    );
    assert.ok(logs.some((l) => l.msg === "rate-limit windows pruned" && l.count === 2), JSON.stringify(logs));
  });
});
