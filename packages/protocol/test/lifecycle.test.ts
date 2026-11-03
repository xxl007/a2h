// Spec protocol/request-lifecycle: "Legal transitions", "Illegal transition",
// "Idempotent replay", "Expiry by the platform", and since m2-approval-page
// "Approval link expiry by the platform" and "Agent cannot approve" (state
// machine part), as a table test over every (state, actor, event) pair
// (protocol skill §12).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ActorSchema, holdStatusAfter, LifecycleEventSchema, NotSentReasonSchema, REQUEST_STATUSES, TERMINAL_STATUSES, transition } from "../src/index.ts";
import type { Actor, LifecycleEvent, RequestStatus } from "../src/index.ts";

/** The only legal (state, actor, event) → target triples (protocol skill §6). */
const LEGAL: Record<string, RequestStatus> = {
  "awaiting_approval|principal|approve": "sent",
  "awaiting_approval|principal|decline": "not_sent",
  "awaiting_approval|platform|expire": "not_sent",
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
  "sent|principal|approve": true,
  "not_sent|principal|decline": true,
  "not_sent|platform|expire": true,
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
  test("awaiting_approval→sent and awaiting_approval→not_sent by the principal; awaiting_approval→not_sent by the platform", () => {
    assert.deepEqual(transition("awaiting_approval", "principal", "approve"), { ok: true, from: "awaiting_approval", to: "sent", changed: true });
    assert.deepEqual(transition("awaiting_approval", "principal", "decline"), { ok: true, from: "awaiting_approval", to: "not_sent", changed: true });
    assert.deepEqual(transition("awaiting_approval", "platform", "expire"), { ok: true, from: "awaiting_approval", to: "not_sent", changed: true });
  });
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
  test("not_sent → sent and awaiting_approval → accepted fail with invalid_transition", () => {
    for (const [from, actor, event] of [
      ["not_sent", "principal", "approve"],
      ["awaiting_approval", "participant", "accept"],
    ] as const) {
      const r = transition(from, actor, event);
      assert.equal(r.ok, false, `${from} ${actor} ${event}`);
      assert.equal(!r.ok && r.error.code, "invalid_transition");
    }
  });
  test("not_sent is terminal", () => {
    assert.ok((TERMINAL_STATUSES as readonly string[]).includes("not_sent"));
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

describe("Scenario: Agent cannot approve (state machine)", () => {
  test("only the principal (approve, decline) and the platform (expire) move a request out of awaiting_approval; there is no agent actor", () => {
    assert.deepEqual([...ActorSchema.options].sort(), ["participant", "platform", "principal"]);
    const leaving: string[] = [];
    for (const actor of actors) for (const event of events) {
      const r = transition("awaiting_approval", actor, event);
      if (r.ok && r.changed) leaving.push(`${actor}|${event}`);
    }
    assert.deepEqual(leaving.sort(), ["platform|expire", "principal|approve", "principal|decline"]);
  });
  test("a request starts in awaiting_approval, and the platform cannot send it", () => {
    assert.equal(REQUEST_STATUSES[0], "awaiting_approval");
    assert.equal(transition("awaiting_approval", "platform", "approve").ok, false);
    assert.equal(transition("awaiting_approval", "participant", "decline").ok, false);
  });
});

describe("Scenario: Approval link expiry by the platform (state machine)", () => {
  test("awaiting_approval expires to not_sent by the platform, and no hold ever existed for it", () => {
    assert.deepEqual(transition("awaiting_approval", "platform", "expire"), { ok: true, from: "awaiting_approval", to: "not_sent", changed: true });
    assert.equal(holdAfter("awaiting_approval"), "none");
    assert.equal(holdAfter("not_sent"), "none");
  });
  test("not_sent carries a reason: declined or expired, nothing else", () => {
    assert.deepEqual([...NotSentReasonSchema.options], ["declined", "expired"]);
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
  test("held while sent/accepted, released on decline/expiry/cancel, captured on answer; none before sending; none on a free lane", () => {
    for (const s of ["awaiting_approval", "not_sent"] as const) assert.equal(holdAfter(s), "none");
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
