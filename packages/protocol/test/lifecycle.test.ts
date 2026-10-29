// Spec protocol/request-lifecycle: "Legal transitions", "Illegal transition",
// "Idempotent replay", "Expiry by the platform" (state machine part), as a
// table test over every (state, actor, event) pair (protocol skill §12).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ActorSchema, holdStatusAfter, LifecycleEventSchema, REQUEST_STATUSES, TERMINAL_STATUSES, transition } from "../src/index.ts";
import type { Actor, LifecycleEvent, RequestStatus } from "../src/index.ts";

/** The only legal (state, actor, event) → target triples (protocol skill §6). */
const LEGAL: Record<string, RequestStatus> = {
  "sent|participant|accept": "accepted",
  "sent|participant|decline": "declined",
  "accepted|participant|answer": "answered",
  "sent|platform|expire": "expired",
  "accepted|platform|expire": "expired",
  "sent|principal|cancel": "cancelled",
  "accepted|principal|cancel": "cancelled",
};
/** Replays: the target state already reached by the same actor and event; a no-op. */
const REPLAY: Record<string, true> = {
  "accepted|participant|accept": true,
  "declined|participant|decline": true,
  "answered|participant|answer": true,
  "expired|platform|expire": true,
  "cancelled|principal|cancel": true,
};

const actors = ActorSchema.options as readonly Actor[];
const events = LifecycleEventSchema.options as readonly LifecycleEvent[];

describe("Lifecycle table: every (state, actor, event)", () => {
  for (const state of REQUEST_STATUSES) {
    for (const actor of actors) {
      for (const event of events) {
        const key = `${state}|${actor}|${event}`;
        const legal = LEGAL[key];
        const replay = REPLAY[key];
        const expectation = legal ? `→ ${legal}` : replay ? "no-op replay" : "invalid_transition";
        test(`${state} + ${actor} + ${event}: ${expectation}`, () => {
          const r = transition(state, actor, event);
          if (legal) {
            assert.deepEqual(r, { ok: true, from: state, to: legal, changed: true });
          } else if (replay) {
            assert.deepEqual(r, { ok: true, from: state, to: state, changed: false });
          } else {
            assert.equal(r.ok, false);
            if (!r.ok) {
              assert.equal(r.error.code, "invalid_transition");
              assert.equal(r.error.stage, "lifecycle");
              assert.equal(r.error.retryable, false);
            }
          }
        });
      }
    }
  }
});

describe("Scenario: Legal transitions", () => {
  test("sent→accepted, accepted→answered, sent→declined, sent→expired, accepted→expired each change state by their actor", () => {
    const cases: [RequestStatus, Actor, LifecycleEvent, RequestStatus][] = [
      ["sent", "participant", "accept", "accepted"],
      ["accepted", "participant", "answer", "answered"],
      ["sent", "participant", "decline", "declined"],
      ["sent", "platform", "expire", "expired"],
      ["accepted", "platform", "expire", "expired"],
    ];
    for (const [from, actor, event, to] of cases) assert.deepEqual(transition(from, actor, event), { ok: true, from, to, changed: true });
  });
});

describe("Scenario: Illegal transition", () => {
  test("answered → accepted and declined → accepted fail with invalid_transition", () => {
    for (const from of ["answered", "declined"] as const) {
      const r = transition(from, "participant", "accept");
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error.code, "invalid_transition");
    }
  });
  test("no transition leaves a terminal state", () => {
    for (const state of TERMINAL_STATUSES) {
      for (const actor of actors) for (const event of events) {
        const r = transition(state, actor, event);
        assert.ok(!r.ok || !r.changed, `${state} ${actor} ${event}`);
      }
    }
  });
  test("the wrong actor cannot cause a legal-looking transition (the principal cannot accept, the participant cannot expire)", () => {
    assert.equal(transition("sent", "principal", "accept").ok, false);
    assert.equal(transition("sent", "participant", "expire").ok, false);
    assert.equal(transition("accepted", "platform", "answer").ok, false);
  });
});

describe("Scenario: Idempotent replay", () => {
  test("the same transition applied twice: the second changes nothing", () => {
    const first = transition("sent", "participant", "accept");
    assert.ok(first.ok && first.changed);
    const second = transition(first.ok ? first.to : "sent", "participant", "accept");
    assert.deepEqual(second, { ok: true, from: "accepted", to: "accepted", changed: false });
  });
});

describe("Scenario: Expiry by the platform (state machine)", () => {
  test("sent and accepted expire by the platform, and the hold is reported as released", () => {
    for (const from of ["sent", "accepted"] as const) {
      const r = transition(from, "platform", "expire");
      assert.ok(r.ok && r.to === "expired");
    }
    assert.equal(transition("sent", "platform", "expire").ok && holdAfter("expired"), "released");
  });
});

function holdAfter(s: RequestStatus) {
  return holdStatusAfter(s, { paid: true });
}

describe("Hold status by state (money represented, not moved)", () => {
  test("held while sent/accepted, released on decline/expiry/cancel, captured on answer; none on a free lane", () => {
    assert.equal(holdAfter("sent"), "held");
    assert.equal(holdAfter("accepted"), "held");
    assert.equal(holdAfter("answered"), "captured");
    for (const s of ["declined", "expired", "cancelled"] as const) assert.equal(holdAfter(s), "released");
    for (const s of REQUEST_STATUSES) assert.equal(holdStatusAfter(s, { paid: false }), "none");
  });
});

describe("delivery outcomes (re-validation at delivery, task 5.2)", () => {
  test("a delivery is either delivered or blocked; nothing else is recorded", async () => {
    const { DELIVERY_OUTCOMES } = await import("../src/index.ts");
    assert.deepEqual([...DELIVERY_OUTCOMES], ["delivered", "blocked"]);
  });
});
