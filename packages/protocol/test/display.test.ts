// Pure display helpers for scenarios whose tool tests live in apps/mcp:
// protocol/discovery "Display string matches the fields" and
// protocol/answer-attestation "Display of the reference answer".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AnswerDisplaySchema, citation, rankingDisplay, signatureDisplay } from "../src/index.ts";
import { SIG } from "./fixtures.ts";

describe("Scenario: Display string matches the fields", () => {
  test("rating 4.8, 48 answers, 0 disputes, six hours → 4.8 · 48 answers · 0 disputes · ~6h", () => {
    assert.equal(rankingDisplay({ rating: 4.8, answers: 48, disputes_lost: 0, typical_latency_seconds: 6 * 3600 }), "4.8 · 48 answers · 0 disputes · ~6h");
  });
  test("one decimal, singular forms, minutes under an hour, days from 48 hours", () => {
    assert.equal(rankingDisplay({ rating: 5, answers: 1, disputes_lost: 1, typical_latency_seconds: 45 * 60 }), "5.0 · 1 answer · 1 dispute · ~45m");
    assert.equal(rankingDisplay({ rating: 0, answers: 0, disputes_lost: 2, typical_latency_seconds: 10 }), "0.0 · 0 answers · 2 disputes · ~1m");
    assert.equal(rankingDisplay({ rating: 4.25, answers: 3, disputes_lost: 0, typical_latency_seconds: 72 * 3600 }), "4.3 · 3 answers · 0 disputes · ~3d");
  });
});

describe("Scenario: Display of the reference answer", () => {
  test("signature display form is a2h:sig:… and the last four characters", () => {
    const display = signatureDisplay(SIG);
    assert.equal(display, "a2h:sig:…AQ==");
    assert.ok(AnswerDisplaySchema.shape.signature.safeParse(display).success);
  });
  test('participant "M. V.", signed 21 Oct 2026 → reviewed by M.V., 21 Oct 2026', () => {
    assert.equal(citation("M. V.", "2026-10-21T09:10:00+02:00"), "reviewed by M.V., 21 Oct 2026");
  });
  test("the date is the signer's local date; labels drop the (simulated) marker for initials", () => {
    assert.equal(citation("M. V. (simulated)", "2026-11-01T00:30:00+01:00"), "reviewed by M.V., 1 Nov 2026");
    assert.equal(citation("Maria van Dijk", "2026-01-05T23:00:00Z"), "reviewed by M.V.D., 5 Jan 2026");
  });
});
