// infra/bootstrap/*.json (applied by hand by the owner, docs/runbooks/aws-bootstrap.md)
// must agree with the code. infra/config.ts is read as text, never executed;
// the JSON is parsed. Field names are found by value, not by Sid, so editing
// statement ids or ordering does not break the checks.
// Contract: openspec/changes/m0-foundation/tasks.md, contract amendment 1.
// Run: node --test tests/ci/bootstrap.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BOOTSTRAP = join(ROOT, "infra/bootstrap");
const config = readFileSync(join(ROOT, "infra/config.ts"), "utf8");
const constant = (name) => {
  const m = config.match(new RegExp(`^export const ${name} = "([^"]+)";`, "m"));
  assert.ok(m, `infra/config.ts: ${name} not found`);
  return m[1];
};
const APP_NAME = constant("APP_NAME");
const BOUNDARY = constant("WORKLOAD_BOUNDARY_POLICY_NAME");

const files = readdirSync(BOOTSTRAP).filter((f) => f.endsWith(".json")).sort();
const doc = Object.fromEntries(files.map((f) => [f, JSON.parse(readFileSync(join(BOOTSTRAP, f), "utf8"))]));
const statements = (f) => [doc[f].Statement ?? []].flat();
/** Every string value in v, recursively. */
const strings = (v) =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
const arnsOf = (v, kind) =>
  strings(v).flatMap((s) => {
    const m = s.match(new RegExp(`^arn:aws:iam::[0-9]{12}:${kind}/(.+)$`));
    return m ? [m[1]] : [];
  });
const globMatch = (pattern, name) =>
  new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);

const trustFiles = files.filter((f) => f.endsWith("-trust.json"));
const deployRoles = trustFiles.map((f) => f.replace(/-trust\.json$/, ""));
const deployIam = files.filter((f) => f.endsWith("-deploy-iam.json"));

test("bootstrap files: a boundary policy, one deploy-iam policy, a dev and a preview trust policy", () => {
  assert.ok(files.includes(`${BOUNDARY}.json`), `infra/bootstrap/${BOUNDARY}.json missing`);
  assert.equal(deployIam.length, 1, "expected exactly one *-deploy-iam.json");
  assert.equal(trustFiles.filter((f) => f.endsWith("-dev-trust.json")).length, 1);
  assert.equal(trustFiles.filter((f) => f.endsWith("-preview-trust.json")).length, 1);
});

test("every policy ARN in the bootstrap is the boundary named WORKLOAD_BOUNDARY_POLICY_NAME", () => {
  const policies = files.flatMap((f) => arnsOf(doc[f], "policy").map((p) => `${f}: ${p}`));
  assert.ok(policies.length > 0, "no boundary policy ARN found");
  assert.deepEqual(policies.filter((p) => !p.endsWith(`: ${BOUNDARY}`)), []);
});

test("the roles the deploy roles may create or manage are role/<APP_NAME>-*", () => {
  const allowed = statements(deployIam[0])
    .filter((s) => s.Effect === "Allow")
    .flatMap((s) => arnsOf(s.Resource, "role"));
  assert.ok(allowed.length > 0, "no role resource in an Allow statement");
  assert.deepEqual([...new Set(allowed)], [`${APP_NAME}-*`]);
});

test("no deploy-role name falls under role/<APP_NAME>-*, and the deploy roles are denied to themselves", () => {
  assert.ok(deployRoles.length >= 2);
  for (const r of deployRoles) {
    assert.ok(!globMatch(`${APP_NAME}-*`, r), `deploy role ${r} matches ${APP_NAME}-*: it could change itself`);
  }
  const denied = statements(deployIam[0])
    .filter((s) => s.Effect === "Deny")
    .flatMap((s) => arnsOf(s.Resource, "role"));
  for (const r of deployRoles) {
    assert.ok(denied.some((p) => globMatch(p, r)), `deploy role ${r} is not covered by a Deny on its own role ARN`);
  }
});

test("trust subjects: dev is ref:refs/heads/main, preview is pull_request, same repository, exact match", () => {
  const sub = "token.actions.githubusercontent.com:sub";
  const subjects = (f) =>
    statements(f).flatMap((s) => Object.entries(s.Condition ?? {}).flatMap(([op, c]) => (sub in c ? [{ op, v: c[sub] }] : [])));
  const repos = new Set();
  for (const [suffix, want] of [["-dev-trust.json", "ref:refs/heads/main"], ["-preview-trust.json", "pull_request"]]) {
    const f = trustFiles.find((t) => t.endsWith(suffix));
    const subs = subjects(f);
    assert.equal(subs.length, 1, `${f}: expected one subject condition`);
    const [{ op, v }] = subs;
    assert.equal(op, "StringEquals", `${f}: subject must be matched exactly`);
    const m = String(v).match(/^repo:([^/:]+\/[^/:]+):(.+)$/);
    assert.ok(m, `${f}: unexpected subject ${v}`);
    assert.equal(m[2], want, `${f}: subject`);
    repos.add(m[1]);
    const aud = statements(f).map((s) => s.Condition?.StringEquals?.["token.actions.githubusercontent.com:aud"]);
    assert.deepEqual(aud, ["sts.amazonaws.com"], `${f}: audience`);
  }
  assert.equal(repos.size, 1, "dev and preview trust different repositories");
  if (process.env.GITHUB_REPOSITORY) assert.deepEqual([...repos], [process.env.GITHUB_REPOSITORY]);
});
