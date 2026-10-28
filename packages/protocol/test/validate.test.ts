// Spec protocol/request-approval "Manifest validation runs before anything
// else" (one test per scenario), "Edit turns the question into a push-poll",
// "Blocked manifests are counted without content", the conflict code for a
// replayed approval with different arguments, and protocol/request-lifecycle
// "Rules changed after approval" at the function level. Design D6.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BlockedManifestSchema, ProtocolErrorSchema, validateManifest } from "../src/index.ts";
import type { Manifest, RulesOfEngagement, ValidationFacts, ValidationPolicy, ValidationResult } from "../src/index.ts";
import { referenceManifest, referenceRules } from "./fixtures.ts";

const NOW = "2026-10-21T08:42:00+02:00"; // Paris, outside quiet hours (22:00–07:00)

const policy: ValidationPolicy = {
  fee_rate: 0.2,
  currency: "EUR",
  monthly_budget_minor: 50_000,
  per_request_cap_minor: 6_000,
  ask_first_above_minor: null,
  daily_request_limit: 20,
  throttled_daily_limit: 2,
};

function facts(over: Partial<ValidationFacts> = {}, rules: Partial<RulesOfEngagement> = {}): ValidationFacts {
  return {
    now: NOW,
    principal: { principal_id: "dev-principal-pr-17", identity_mode: "verified_organisation", verified: true },
    participant: { participant_id: "p_sim_mv", handle: "sim-mv-7f3c", rules: { ...referenceRules, ...rules } },
    interruptions_today: 0,
    budget: { used_minor: 0, currency: "EUR" },
    requests_today: 0,
    principal_throttled: false,
    approval: "pending",
    ...over,
  };
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  return { ...referenceManifest, ...over };
}

function fails(r: ValidationResult) {
  assert.equal(r.ok, false, `expected a failure, got ${JSON.stringify(r)}`);
  if (r.ok) throw new Error("unreachable");
  assert.ok(ProtocolErrorSchema.safeParse(r.error).success, "error is a ProtocolError");
  return r;
}

/** No part of a tool-facing error may carry the question or the participant's rules. */
function assertNoLeak(r: ValidationResult, m: Manifest = referenceManifest) {
  if (r.ok) return;
  const text = JSON.stringify(r.error);
  assert.ok(!text.includes(m.question), "error carries the question");
  for (const secret of ["2500", "3125", "22:00", "07:00", "Europe/Paris", "reserve", "quiet", "interruption", "86400"]) {
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `error reveals ${secret}: ${text}`);
  }
}

describe("passing manifest", () => {
  test("the reference manifest passes, delivered now, ETA = delivery + latency promise", () => {
    const r = validateManifest(referenceManifest, facts(), policy);
    assert.deepEqual(r, { ok: true, deferred: false, deliver_at: "2026-10-21T06:42:00.000Z", eta: "2026-10-22T06:42:00.000Z" });
  });
});

describe("Scenario: Bid below reserve", () => {
  test("bid under the gross reserve (3125 from net 2500 at 20%) → outside_participant_rules, detail does not state the reserve", () => {
    const m = manifest({ bid_minor: 3124 });
    const r = fails(validateManifest(m, facts(), policy));
    assert.deepEqual([r.error.code, r.error.stage, r.error.retryable], ["outside_participant_rules", "rules", false]);
    assert.equal(r.blocked?.code, "bid_below_reserve");
    assertNoLeak(r, m);
  });
  test("a bid equal to the gross reserve passes", () => {
    assert.equal(validateManifest(manifest({ bid_minor: 3125 }), facts(), policy).ok, true);
  });
});

describe("Scenario: Push-poll", () => {
  test("persuasion disguised as a question → forbidden_content, stage content", () => {
    const m = manifest({ question: "Wouldn't you agree that the new clinic is a waste of taxpayer money?" });
    const r = fails(validateManifest(m, facts(), policy));
    assert.deepEqual([r.error.code, r.error.stage], ["forbidden_content", "content"]);
    assertNoLeak(r, m);
  });
});

describe("Scenario: Third-party personal data", () => {
  test("personal data about someone other than the participant → forbidden_content", () => {
    const r = fails(validateManifest(manifest({ question: "What is your neighbour's home address?" }), facts(), policy));
    assert.equal(r.error.code, "forbidden_content");
  });
});

describe("Scenario: Labour disguised as a question", () => {
  test("work rather than an answer → forbidden_content", () => {
    const r = fails(validateManifest(manifest({ question: "Write a 2,000-word blog post about diabetes management." }), facts(), policy));
    assert.equal(r.error.code, "forbidden_content");
  });
  test("a push-poll hidden in poll options is caught too", () => {
    const m = manifest({
      intent: "opinion",
      format: "poll",
      question: "Which statement is closest to your view?",
      options: [
        { id: "a", label: "Fine as it is" },
        { id: "b", label: "Isn't it true that the mayor lied about the budget?" },
      ],
    });
    assert.equal(fails(validateManifest(m, facts({}, { types: [{ intent: "opinion", accepted: true, reserve_net_minor: 500, currency: "EUR" }] }), policy)).error.code, "forbidden_content");
  });
});

describe("Scenario: Quiet hours", () => {
  const night = "2026-10-21T23:30:00+02:00";
  test("inside quiet hours with room before expiry → succeeds, deferred to the end of quiet hours", () => {
    const r = validateManifest(manifest(), facts({ now: night }, { latency_promise_seconds: 6 * 3600 }), policy);
    assert.deepEqual(r, { ok: true, deferred: true, deliver_at: "2026-10-22T05:00:00.000Z", eta: "2026-10-22T11:00:00.000Z" });
  });
  test("inside quiet hours and the expiry does not allow a later delivery → outside_participant_rules, retryable", () => {
    const m = manifest({ expires_at: "2026-10-22T09:00:00+02:00" });
    const r = fails(validateManifest(m, facts({ now: night }, { latency_promise_seconds: 6 * 3600 }), policy));
    assert.deepEqual([r.error.code, r.error.stage, r.error.retryable], ["outside_participant_rules", "rules", true]);
    assert.equal(r.blocked?.code, "quiet_hours");
    assertNoLeak(r, m);
  });
  test("deferral follows the participant's wall clock across a DST change (25 Oct 2026, Paris)", () => {
    const m = manifest({ expires_at: "2026-10-27T12:00:00+01:00" });
    const r = validateManifest(m, facts({ now: "2026-10-24T23:30:00+02:00" }, { latency_promise_seconds: 3600 }), policy);
    assert.ok(r.ok);
    assert.equal(r.deliver_at, "2026-10-25T06:00:00.000Z"); // 07:00 CET
  });
  test("a daytime quiet window (12:00–14:00) is honoured, and no quiet hours means no deferral", () => {
    const qh = { start: "12:00", end: "14:00", time_zone: "Europe/Paris" };
    const r = validateManifest(manifest(), facts({ now: "2026-10-21T12:15:00+02:00" }, { quiet_hours: qh, latency_promise_seconds: 3600 }), policy);
    assert.ok(r.ok && r.deferred && r.deliver_at === "2026-10-21T12:00:00.000Z");
    const free = validateManifest(manifest(), facts({ now: "2026-10-21T23:30:00+02:00" }, { quiet_hours: null, latency_promise_seconds: 3600 }), policy);
    assert.ok(free.ok && !free.deferred);
  });
  test("an unknown time zone fails closed", () => {
    const r = fails(validateManifest(manifest(), facts({}, { quiet_hours: { start: "22:00", end: "07:00", time_zone: "Mars/Olympus" } }), policy));
    assert.equal(r.blocked?.code, "quiet_hours");
  });
});

describe("Scenario: Interruption budget exceeded", () => {
  test("interruptions for the day used up → outside_participant_rules, counted for the participant", () => {
    const r = fails(validateManifest(manifest(), facts({ interruptions_today: 3 }), policy));
    assert.equal(r.error.code, "outside_participant_rules");
    assert.ok(r.blocked, "a blocked record is returned for the participant's count");
    assert.equal(r.blocked.code, "interruption_budget");
    assertNoLeak(r);
  });
});

describe("Scenario: Blocked row (record content)", () => {
  test("a rules-stage block yields participant id, principal id, stage, code and time, and nothing else", () => {
    const r = fails(validateManifest(manifest({ bid_minor: 100 }), facts(), policy));
    assert.deepEqual(r.blocked, { participant_id: "p_sim_mv", principal_id: "dev-principal-pr-17", stage: "rules", code: "bid_below_reserve", at: NOW });
    assert.ok(BlockedManifestSchema.safeParse(r.blocked).success);
  });
  test("failures outside the rules stage produce no blocked record", () => {
    const r = fails(validateManifest(manifest({ question: "Draft a business plan for my bakery." }), facts(), policy));
    assert.equal(r.blocked, undefined);
  });
});

describe("Scenario: Edit turns the question into a push-poll", () => {
  test("the edited text is validated like any other: forbidden_content", () => {
    const edited = manifest({ question: "Isn't it true that this leaflet was written by incompetent people?" });
    assert.equal(fails(validateManifest(edited, facts({ approval: "recorded" }), policy)).error.code, "forbidden_content");
  });
});

describe("Approval binding: conflict on a replayed approval with different arguments", () => {
  test("matching manifest hashes pass; a mismatch → conflict and nothing else is evaluated", () => {
    assert.equal(validateManifest(manifest(), facts({ approval: "recorded", approval_binding: { issued_for: "abc", presented: "abc" } }), policy).ok, true);
    const r = fails(validateManifest(manifest({ bid_minor: 1 }), facts({ approval: "recorded", approval_binding: { issued_for: "abc", presented: "abd" } }), policy));
    assert.deepEqual([r.error.code, r.error.retryable], ["conflict", false]);
  });
});

describe("Every stage and code, in pipeline order", () => {
  const cases: [string, Manifest, ValidationFacts, string, string, string?][] = [
    ["fractional bid", manifest({ bid_minor: 30.5 }), facts(), "schema_invalid", "schema"],
    ["expiry already past", manifest({ expires_at: "2026-10-21T08:00:00+02:00" }), facts(), "schema_invalid", "schema"],
    ["currency other than the policy's", manifest({ currency: "USD" }), facts(), "schema_invalid", "schema"],
    ["manifest of another principal", manifest({ principal_id: "someone-else" }), facts(), "principal_not_accountable", "principal"],
    ["unverified principal", manifest(), facts({ principal: { principal_id: "dev-principal-pr-17", identity_mode: "verified_organisation", verified: false } }), "principal_not_accountable", "principal"],
    ["authorisation from a non-real-name principal", manifest({ intent: "authorisation" }), facts(), "principal_not_verified_for_lane", "principal"],
    ["type not accepted", manifest({ intent: "estimate" }), facts(), "outside_participant_rules", "rules", "type_not_accepted"],
    ["type not listed at all", manifest({ intent: "observation" }), facts(), "outside_participant_rules", "rules", "type_not_accepted"],
    ["free lane not declared", manifest({ lane: "free", free_lane: "facts_about_self", bid_minor: 0 }), facts(), "outside_participant_rules", "rules", "free_lane_mismatch"],
    ["organisations only, person asking", manifest(), facts({ principal: { principal_id: "dev-principal-pr-17", identity_mode: "real_name", verified: true } }, { who_may_ask: "organisations_only" }), "outside_participant_rules", "rules", "asker_not_allowed"],
    ["latency promise beyond expiry", manifest({ expires_at: "2026-10-21T20:00:00+02:00" }), facts(), "outside_participant_rules", "rules", "latency_mismatch"],
    ["over monthly budget", manifest(), facts({ budget: { used_minor: 48_000, currency: "EUR" } }), "over_budget", "budget"],
    ["over per-request cap", manifest({ bid_minor: 6_001 }), facts(), "over_cap", "budget"],
    ["no approval and an ask-first policy", manifest(), facts({ approval: "none" }), "approval_required", "budget"],
    ["daily limit reached", manifest(), facts({ requests_today: 20 }), "rate_limited", "throttle"],
    ["throttled principal hits the lower limit", manifest(), facts({ requests_today: 2, principal_throttled: true }), "rate_limited", "throttle"],
  ];
  for (const [name, m, f, code, stage, blocked] of cases) {
    test(`${name} → ${code} at ${stage}${blocked ? ` (${blocked})` : ""}`, () => {
      const r = fails(validateManifest(m, f, policy));
      assert.deepEqual([r.error.code, r.error.stage], [code, stage]);
      assert.equal(r.blocked?.code, blocked);
      assertNoLeak(r, m);
    });
  }
  test("rate_limited is retryable, budget failures are not", () => {
    assert.equal(fails(validateManifest(manifest(), facts({ requests_today: 20 }), policy)).error.retryable, true);
    assert.equal(fails(validateManifest(manifest(), facts({ budget: { used_minor: 48_000, currency: "EUR" } }), policy)).error.retryable, false);
  });
  test("the first failing stage wins: content beats rules, budget and throttle", () => {
    const m = manifest({ question: "Draft a business plan for my bakery.", bid_minor: 100 });
    const r = fails(validateManifest(m, facts({ requests_today: 99, budget: { used_minor: 49_999, currency: "EUR" } }), policy));
    assert.equal(r.error.stage, "content");
  });
  test("principal beats content; schema beats principal", () => {
    const m = manifest({ question: "Draft a business plan for my bakery.", principal_id: "someone-else" });
    assert.equal(fails(validateManifest(m, facts(), policy)).error.stage, "principal");
    assert.equal(fails(validateManifest({ ...m, bid_minor: 1.5 }, facts(), policy)).error.stage, "schema");
  });
  test("a free-lane manifest matching a declared free lane needs no reserve and no budget headroom", () => {
    const m = manifest({ lane: "free", free_lane: "own_publications", bid_minor: 0 });
    assert.equal(validateManifest(m, facts({ budget: { used_minor: 50_000, currency: "EUR" } }), policy).ok, true);
  });
  test("an ask-first threshold lets small bids through without a recorded approval", () => {
    assert.equal(validateManifest(manifest(), facts({ approval: "none" }), { ...policy, ask_first_above_minor: 4_000 }).ok, true);
    assert.equal(fails(validateManifest(manifest({ bid_minor: 4_001 }), facts({ approval: "none" }), { ...policy, ask_first_above_minor: 4_000 })).error.code, "approval_required");
  });
});

describe("Scenario: Rules changed after approval (delivery phase)", () => {
  test("at delivery the participant's current rules are applied again: a raised reserve blocks", () => {
    const raised = { types: [{ intent: "judgment" as const, accepted: true, reserve_net_minor: 3000, currency: "EUR" }] };
    const r = fails(validateManifest(manifest(), facts({ approval: "recorded" }, raised), policy, { phase: "delivery" }));
    assert.equal(r.blocked?.code, "bid_below_reserve");
  });
  test("delivery does not count the request against budget or rate limit a second time", () => {
    const f = facts({ approval: "recorded", requests_today: 20, budget: { used_minor: 50_000, currency: "EUR" } });
    assert.equal(validateManifest(manifest(), f, policy, { phase: "delivery" }).ok, true);
  });
});

describe("Caller errors are not principal errors", () => {
  test("malformed facts or policy throw a TypeError instead of passing", () => {
    assert.throws(() => validateManifest(manifest(), { ...facts(), interruptions_today: -1 }, policy), TypeError);
    assert.throws(() => validateManifest(manifest(), facts(), { ...policy, fee_rate: 1 }), TypeError);
  });
});
