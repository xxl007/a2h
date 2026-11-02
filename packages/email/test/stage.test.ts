// The stage label of non-production emails (design.md "Email: magic link"):
// the same words as the screens' stage line, never "development".
import { test } from "node:test";
import assert from "node:assert/strict";
import { stageLabel } from "../src/index.ts";

test("dev and previews are a test stage; prod has no label", () => {
  assert.equal(stageLabel("dev"), "test stage dev");
  assert.equal(stageLabel("pr-12"), "test stage pr-12");
  assert.equal(stageLabel("prod"), undefined);
});

test("unknown stages are refused", () => {
  assert.throws(() => stageLabel("staging"));
});
