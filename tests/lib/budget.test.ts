// The budget guard's accounting (lib/budget.ts, issue #114), checked without
// a stage against the server's rule: packages/db/src/queries/mcp.ts
// `principalUsage` (sent and accepted count the bid, answered the cleared
// amount or else the bid, every other status nothing; created since the UTC
// month start; the daily count is requests created today and sent) and
// packages/protocol validate.ts stage 5 (refused when used + bid > budget)
// and 6 (refused when requests today >= the daily limit). The server side of
// the same rule is pinned by packages/db/test/approval.test.ts ("budget used
// and requests today ignore awaiting_approval and not_sent rows").
// Run: node --test lib/budget.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckedRequest } from "@a2h/protocol";
import { committedBy, guardVerdict, LIST_LIMIT, SENT_STATUSES, usageOf } from "./budget.ts";

const MONTH = new Date("2026-11-01T00:00:00Z");
const DAY = new Date("2026-11-10T00:00:00Z");
const POLICY = { monthly_budget_minor: 50_000, daily_request_limit: 50 };

let n = 0;
function req(status: CheckedRequest["status"], o: { held?: number; cleared?: number; created?: string; legacy?: boolean } = {}): CheckedRequest {
  const created = o.created ?? "2026-11-10T12:00:00Z";
  const unsent = status === "awaiting_approval" || status === "not_sent";
  return {
    request_id: `A2H-${String(++n).padStart(4, "0")}`,
    status,
    handle: "sim-jw-9e48",
    simulated: true,
    intent: "opinion",
    transitions: o.legacy ? { sent_at: created } : { awaiting_approval_at: created, ...(unsent ? {} : { sent_at: created }) },
    ...(unsent ? {} : { held_minor: o.held ?? 750 }),
    ...(o.cleared !== undefined ? { cleared_minor: o.cleared } : {}),
    hold_status: "none",
    currency: "EUR",
    files: [],
  } as unknown as CheckedRequest;
}

function byStatus(rs: CheckedRequest[]): Record<string, CheckedRequest[]> {
  const out: Record<string, CheckedRequest[]> = {};
  for (const s of SENT_STATUSES) out[s] = rs.filter((r) => r.status === s);
  return out;
}

test("each status counts what the server's CASE counts: sent and accepted the bid, answered the cleared amount, the rest nothing", () => {
  assert.equal(committedBy(req("sent", { held: 3125 })), 3125);
  assert.equal(committedBy(req("accepted", { held: 3125 })), 3125);
  assert.equal(committedBy(req("answered", { held: 3125, cleared: 2900 })), 2900);
  assert.equal(committedBy(req("answered", { held: 3125 })), 3125, "answered without a cleared amount: the bid (coalesce)");
  for (const s of ["awaiting_approval", "not_sent", "declined", "expired", "cancelled"] as const) {
    assert.equal(committedBy(req(s, { held: 3125 })), 0, `${s} holds nothing`);
  }
});

test("usage: the month's committing requests, today's sent ones; earlier months and unsent requests count for nothing", () => {
  const rs = [
    req("sent", { held: 4400 }),
    req("accepted", { held: 900 }),
    req("answered", { held: 800, cleared: 775 }),
    req("declined", { held: 2250 }),
    req("expired", { held: 4375, created: "2026-11-09T23:59:59Z" }),
    req("answered", { held: 3750, cleared: 3750, created: "2026-11-02T08:00:00Z" }),
    req("answered", { held: 5000, cleared: 5000, created: "2026-10-31T23:59:59Z" }),
    req("sent", { held: 1000, legacy: true }),
  ];
  const u = usageOf(byStatus(rs), MONTH, DAY);
  assert.equal(u.committed_minor, 4400 + 900 + 775 + 3750 + 1000);
  // Today and sent: sent, accepted, answered, declined, legacy sent (the expired one was created yesterday).
  assert.equal(u.requests_today, 5);
  assert.equal(u.complete, true);
});

test("awaiting approval and not sent are never listed by the guard and never counted (issue #114: no hold before Send)", () => {
  const listed = byStatus([req("sent", { held: 3125 })]);
  // Even if a listing returned them (it does not: one listing per counting status), they count for nothing.
  listed["sent"]!.push(req("awaiting_approval"), req("not_sent"));
  assert.deepEqual(usageOf(listed, MONTH, DAY), { committed_minor: 3125, requests_today: 1, complete: true });
});

test("a full listing makes the usage a lower bound, and the guard then skips", () => {
  const many = Array.from({ length: LIST_LIMIT }, () => req("answered", { held: 10, cleared: 10 }));
  const u = usageOf(byStatus(many), MONTH, DAY);
  assert.equal(u.complete, false);
  const v = guardVerdict(u, POLICY, 0, 0);
  assert.ok(v && /cannot be read completely/.test(v), String(v));
});

test("the guard skips exactly where the server would refuse: over_budget past the budget, rate_limited at the daily limit", () => {
  const at = (committed: number, today: number) => ({ committed_minor: committed, requests_today: today, complete: true });
  assert.equal(guardVerdict(at(40_000, 0), POLICY, 10_000, 1), false, "used + bid = budget is accepted");
  const over = guardVerdict(at(40_001, 0), POLICY, 10_000, 1);
  assert.ok(over && /over_budget/.test(over) && /committed 40001 of 50000/.test(over), String(over));
  assert.equal(guardVerdict(at(0, 47), POLICY, 0, 3), false, "the third request sees 49 sent today: accepted");
  const limit = guardVerdict(at(0, 48), POLICY, 0, 3);
  assert.ok(limit && /daily limit/.test(limit), String(limit));
});
