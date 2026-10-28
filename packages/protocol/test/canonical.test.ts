// Spec protocol/schemas: "Canonical form of the reference answer".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalAnswerPayload, canonicalJson } from "../src/index.ts";
import { omit, referenceEnvelope } from "./fixtures.ts";

const REFERENCE =
  '{"answered_personally":true,"body":{"note":{"text":"Clear overall; the dosage table should be larger."},"verdict":"yes"},' +
  '"confidence":4,"participant_id":"p_sim_mv","request_id":"A2H-7f3c","signed_at":"2026-10-21T09:10:00+02:00"}';

/** Rebuild an object with its keys in reverse order, at every level. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
  }
  return value;
}

describe("Scenario: Canonical form of the reference answer", () => {
  test("reproduces the reference string byte for byte", () => {
    assert.equal(canonicalAnswerPayload(referenceEnvelope), REFERENCE);
  });
  test("key order of the input is irrelevant", () => {
    const shuffled = reversed(referenceEnvelope) as typeof referenceEnvelope;
    assert.notEqual(JSON.stringify(shuffled), JSON.stringify(referenceEnvelope));
    assert.equal(canonicalAnswerPayload(shuffled), REFERENCE);
  });
  test("covers exactly the six signed fields: key_id and signature are not part of it", () => {
    const keys = Object.keys(JSON.parse(canonicalAnswerPayload(referenceEnvelope)) as object);
    assert.deepEqual(keys, ["answered_personally", "body", "confidence", "participant_id", "request_id", "signed_at"]);
    assert.equal(canonicalAnswerPayload({ ...referenceEnvelope, key_id: "other", signature: "x" }), REFERENCE);
  });
  test("an absent signed field is refused, not silently dropped", () => {
    assert.throws(() => canonicalAnswerPayload(omit(referenceEnvelope, "answered_personally") as never), TypeError);
  });
});

describe("canonicalJson", () => {
  test("sorts keys at every level, keeps array order, no whitespace", () => {
    assert.equal(canonicalJson({ b: [3, { z: 1, a: 2 }], a: "x" }), '{"a":"x","b":[3,{"a":2,"z":1}]}');
  });
  test("keeps non-ASCII characters as UTF-8 text, escaping only what JSON requires", () => {
    assert.equal(canonicalJson({ t: "Clé « ok »\n" }), '{"t":"Clé « ok »\\n"}');
  });
  test("omits undefined members and refuses values JSON cannot carry", () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1]) {
      assert.throws(() => canonicalJson({ v: bad }), TypeError);
    }
  });
});
