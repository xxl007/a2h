// The sign-in allow-list parameter is created by every stage's deploy
// (m1-hosted-connector design D7, group 8.3 fact): dev's shared name, prod's
// own, and a preview's own `/a2h/pr-<n>/principal-allowlist`, which the web
// Lambda of that preview reads and the verify job fills. A preview that does
// not create it fails closed for everyone (nobody can sign in) and the
// verify job's allow-list step fails: PR #59, run 41341731766.
// index.ts has no unit harness (SST globals), so the wiring is read from its
// source: the call sits in deploy(), the path every stage takes, not only in
// ownResources() (dev and prod).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowlistParameterName, stageInfo } from "../config.ts";

const INDEX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");

function body(fn: string): string {
  const start = INDEX.indexOf(fn);
  assert.notEqual(start, -1, `${fn} not found in infra/index.ts`);
  const open = INDEX.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === "{") depth++;
    else if (INDEX[i] === "}" && --depth === 0) return INDEX.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after ${fn}`);
}

test("every stage's deploy creates its own allow-list parameter: createAllowlist(stage) is called in deploy(), after the stage's secrets, not only for dev and prod", () => {
  const deploy = body("export async function deploy(");
  assert.match(deploy, /createAllowlist\(stage\)/, "deploy() does not create the allow-list: a preview deploys without its parameter");
  assert.doesNotMatch(body("function ownResources("), /createAllowlist/, "the allow-list is not a dev/prod-only resource");
  assert.ok(deploy.indexOf("createStageSecrets(stage)") < deploy.indexOf("createAllowlist(stage)"), "next to the per-stage secrets, which every stage also creates");
});

test("the parameter each stage creates is the one its web Lambda reads", () => {
  assert.equal(allowlistParameterName(stageInfo("dev")), "/a2h/shared/principal-allowlist");
  assert.equal(allowlistParameterName(stageInfo("prod")), "/a2h/prod/principal-allowlist");
  assert.equal(allowlistParameterName(stageInfo("pr-59")), "/a2h/pr-59/principal-allowlist");
});
