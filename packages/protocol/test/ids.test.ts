// Spec protocol/schemas "Identifier formats": randomness is an argument.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatHandle, formatRequestId, isRequestId, parseHandle, parseRequestId } from "../src/index.ts";

describe("Scenario: Request id from given randomness", () => {
  test("the bytes that spell 7f3c give A2H-7f3c", () => {
    assert.equal(formatRequestId(new Uint8Array([0x7f, 0x3c])), "A2H-7f3c");
  });
  test("leading zeros are kept and output is lower case", () => {
    assert.equal(formatRequestId(new Uint8Array([0x00, 0x0a])), "A2H-000a");
    assert.equal(formatRequestId(new Uint8Array([0xff, 0xff])), "A2H-ffff");
  });
  test("exactly two bytes of randomness are required", () => {
    for (const n of [0, 1, 3]) assert.throws(() => formatRequestId(new Uint8Array(n)), RangeError);
  });
});

describe("Scenario: Malformed id rejected", () => {
  for (const bad of ["A2H-7F3C", "A2H-7f3", "A2H-7f3c0", "a2h-7f3c", "A2H_7f3c", " A2H-7f3c", "A2H-7g3c", ""]) {
    test(`${JSON.stringify(bad)} is rejected`, () => {
      assert.equal(isRequestId(bad), false);
      assert.throws(() => parseRequestId(bad), RangeError);
    });
  }
  test("A2H-7f3c parses", () => {
    assert.equal(isRequestId("A2H-7f3c"), true);
    assert.equal(parseRequestId("A2H-7f3c"), "A2H-7f3c");
  });
});

describe("Handles: short lower-case slug, hyphen, four lower-case hex", () => {
  test("formatHandle(slug, randomness)", () => {
    assert.equal(formatHandle("mv", new Uint8Array([0x7f, 0x3c])), "mv-7f3c");
    assert.equal(formatHandle("sim-mv", new Uint8Array([0x7f, 0x3c])), "sim-mv-7f3c");
  });
  test("an invalid slug or randomness is refused", () => {
    for (const slug of ["", "MV", "m v", "-mv", "mv-", "a".repeat(30), "ana@example"]) {
      assert.throws(() => formatHandle(slug, new Uint8Array([1, 2])), RangeError, slug);
    }
    assert.throws(() => formatHandle("mv", new Uint8Array([1])), RangeError);
  });
  test("parseHandle splits slug and suffix and rejects malformed handles", () => {
    assert.deepEqual(parseHandle("sim-mv-7f3c"), { slug: "sim-mv", suffix: "7f3c" });
    for (const bad of ["mv-7F3C", "mv7f3c", "mv-7f3", "MV-7f3c", "mv--7f3c"]) assert.throws(() => parseHandle(bad), RangeError, bad);
  });
});
