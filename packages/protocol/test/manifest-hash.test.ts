// The hash the approval state binds (design D1): the same arguments give the
// same hash whatever their key order; any change gives another hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson, manifestHash } from "../src/index.ts";
import { referenceInput } from "./fixtures.ts";

test("manifestHash is lower-case hex SHA-256 of the canonical JSON", async () => {
  const expected = createHash("sha256").update(canonicalJson(referenceInput), "utf8").digest("hex");
  assert.equal(await manifestHash(referenceInput), expected);
});

test("key order does not change the hash; any field change does", async () => {
  const reordered = Object.fromEntries(Object.entries(referenceInput).reverse()) as typeof referenceInput;
  assert.equal(await manifestHash(reordered), await manifestHash(referenceInput));
  assert.notEqual(await manifestHash({ ...referenceInput, bid_minor: 3501 }), await manifestHash(referenceInput));
  assert.notEqual(await manifestHash({ ...referenceInput, question: referenceInput.question + " " }), await manifestHash(referenceInput));
});
