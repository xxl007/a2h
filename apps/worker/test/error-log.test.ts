// Review N7: an error is logged by name and SQLSTATE code only. A pg error's
// message can carry a value (`invalid input syntax for type integer: "…"`),
// so it never reaches a log line. The one exception is the deployment
// adapter's own configuration message, which names a variable, never a value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { errorFields } from "../src/error-log.ts";

const VALUE = "Would a patient find this leaflet alarming?";

test("a pg error is logged by name and SQLSTATE code; its message, which carries a value, is not", () => {
  const error = new pg.DatabaseError(`invalid input syntax for type integer: "${VALUE}"`, 0, "error");
  error.code = "22P02";
  const fields = errorFields(error);
  assert.deepEqual(fields, { error: "error", code: "22P02" });
  assert.ok(!JSON.stringify(fields).includes(VALUE));
});

test("any other error: its name only, never its message", () => {
  assert.deepEqual(errorFields(new TypeError(`bad ${VALUE}`)), { error: "TypeError" });
  assert.deepEqual(errorFields(Object.assign(new Error(VALUE), { code: VALUE })), { error: "Error" }, "a code that is not a SQLSTATE is not logged");
  assert.deepEqual(errorFields("a string"), { error: "unknown" });
});

test("the deployment adapter's configuration message names the variable and is kept", () => {
  assert.deepEqual(errorFields(new Error("worker configuration: DB_HOST is not set")), {
    error: "Error",
    detail: "worker configuration: DB_HOST is not set",
  });
});

test("every error log site of the worker goes through errorFields (no error.message anywhere in src)", () => {
  for (const file of ["worker.ts", "index.ts"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.message\b/, `${file} reads error.message`);
    assert.match(source, /errorFields\(/, `${file} logs through errorFields`);
  }
});
