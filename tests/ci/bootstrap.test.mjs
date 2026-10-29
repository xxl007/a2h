// infra/bootstrap/*.json (applied by hand by the owner, docs/runbooks/aws-bootstrap.md)
// must agree with the code. infra/config.ts is read as text (the §14 checks at
// the end import it and infra/stage-secrets.ts, both pure, no AWS call);
// the JSON is parsed. Field names are found by value, not by Sid, so editing
// statement ids or ordering does not break the checks.
// Contract: openspec/changes/m0-foundation/tasks.md, contract amendment 1;
// §14 of the runbook: openspec/changes/archive/2026-10-29-m1-protocol-connector/tasks.md 6.3.
// Run: node --test tests/ci/bootstrap.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  // Repositories created after 2026-07-15 carry immutable ids: repo:OWNER@ID/REPO@ID:... (GitHub OIDC reference).
  const withoutIds = (r) => r.replace(/@\d+/g, "");
  if (process.env.GITHUB_REPOSITORY) assert.deepEqual([...repos].map(withoutIds), [process.env.GITHUB_REPOSITORY]);
});

// --- docs/runbooks/aws-bootstrap.md §14: per-stage signing and approval keys --
// (m1-protocol-connector task 6.3). Every `sh` block of §14 is syntax-checked
// with `bash -n`, then run against stub `aws` and `gh` executables that only
// record their arguments (no network, no credentials). The recorded calls must
// be read-only, use the runbook's profile and region, never read or write a
// secret value, and name only the secrets infra/stage-secrets.ts creates.
// Both modules are imported as TypeScript (Node 22 strips types).

const RUNBOOK = readFileSync(join(ROOT, "docs/runbooks/aws-bootstrap.md"), "utf8");
const section14 = (() => {
  const start = RUNBOOK.search(/^## 14\. /m);
  if (start < 0) return "";
  const rest = RUNBOOK.slice(start + 1);
  const next = rest.search(/^## /m);
  return next < 0 ? RUNBOOK.slice(start) : RUNBOOK.slice(start, start + 1 + next);
})();
const shBlocks = [...section14.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
const READ_ONLY_AWS = new Set([
  "secretsmanager describe-secret",
  "secretsmanager list-secret-version-ids",
  "ssm get-parameter",
  "ecs list-services",
  "ecs describe-services",
  "ecs describe-task-definition",
  "iam list-attached-role-policies",
  "iam get-policy",
  "iam get-policy-version",
]);

/** Run every §14 block against recording stubs; returns the argv of each aws and gh call. */
function dryRun14() {
  const dir = mkdtempSync(join(tmpdir(), "runbook14-"));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  for (const tool of ["aws", "gh"]) {
    const stub = join(dir, tool);
    // One JSON line per call; prints a placeholder so command substitutions get a value.
    writeFileSync(
      stub,
      `#!/usr/bin/env node\nconst fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},JSON.stringify([${JSON.stringify(tool)},...process.argv.slice(2)])+"\\n");console.log("stub-value");\n`,
    );
    chmodSync(stub, 0o755);
  }
  for (const [i, block] of shBlocks.entries()) {
    const syntax = spawnSync("bash", ["-n", "-c", block], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `§14 block ${i + 1}: bash -n failed\n${syntax.stderr}`);
    const run = spawnSync("bash", ["-euo", "pipefail", "-c", block], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir },
    });
    assert.equal(run.status, 0, `§14 block ${i + 1} failed against the stubs\n${run.stderr}`);
  }
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("runbook §14 exists and has shell blocks", () => {
  assert.ok(section14, "docs/runbooks/aws-bootstrap.md has no '## 14.' section");
  assert.ok(shBlocks.length >= 2, "§14 has fewer than two sh blocks");
});

test("runbook §14 dry run: read-only AWS calls with the runbook's profile and region, never a secret value", () => {
  const calls = dryRun14();
  const aws = calls.filter((c) => c[0] === "aws").map((c) => c.slice(1));
  assert.ok(aws.length > 0, "§14 makes no aws call");
  for (const argv of aws) {
    const op = argv.filter((a) => !a.startsWith("--")).slice(0, 2).join(" ");
    assert.ok(READ_ONLY_AWS.has(op), `§14 runs a non-read-only or unexpected aws call: ${argv.join(" ")}`);
    assert.equal(argv[argv.indexOf("--profile") + 1], "a2h-member", `profile: ${argv.join(" ")}`);
    if (!op.startsWith("iam ")) assert.equal(argv[argv.indexOf("--region") + 1], "eu-west-3", `region: ${argv.join(" ")}`);
  }
  assert.doesNotMatch(section14, /get-secret-value|put-secret-value|create-secret|delete-secret|update-secret|rotate-secret/);
  const gh = calls.filter((c) => c[0] === "gh").map((c) => c.slice(1));
  for (const argv of gh) {
    assert.ok(["run list", "run watch", "workflow run"].includes(argv.slice(0, 2).join(" ")), `gh: ${argv.join(" ")}`);
    assert.equal(argv[argv.indexOf("--repo") + 1], "xxl007/a2h");
  }
});

test("runbook §14 names exactly the secrets infra creates, and the generations infra/config.ts has", async () => {
  const { stageSecretName, STAGE_SECRET_KINDS } = await import(join(ROOT, "infra/stage-secrets.ts"));
  const { stageInfo, STAGE_KEY_GENERATIONS } = await import(join(ROOT, "infra/config.ts"));
  const known = new Set(["dev", "prod"].flatMap((s) => STAGE_SECRET_KINDS.map((k) => stageSecretName(stageInfo(s), k))));
  const ids = dryRun14()
    .filter((c) => c[0] === "aws" && c.includes("--secret-id"))
    .map((c) => c[c.indexOf("--secret-id") + 1]);
  assert.ok(ids.length > 0, "§14 inspects no secret");
  for (const id of ids) assert.ok(known.has(id), `§14 names ${id}, which infra does not create`);
  for (const name of known) {
    if (name.startsWith("a2h/dev/")) assert.ok(ids.includes(name), `§14 does not inspect ${name}`);
  }
  // Every STAGE_KEY_GENERATIONS.<stage>.<kind> the text refers to exists.
  const refs = [...section14.matchAll(/STAGE_KEY_GENERATIONS\.(\w+)\.(\w+)/g)];
  assert.ok(refs.length > 0, "§14 does not say which generation to bump");
  for (const [, stage, kind] of refs) {
    assert.ok(Number.isInteger(STAGE_KEY_GENERATIONS[stage]?.[kind]), `STAGE_KEY_GENERATIONS.${stage}.${kind} not in infra/config.ts`);
  }
});

test("no IAM change for the stage secrets: deploy roles hold PowerUserAccess, the boundary lets tasks read a2h/<stage>/*", async () => {
  // Deploy roles: §3 attaches PowerUserAccess (all of Secrets Manager) to both.
  assert.match(RUNBOOK, /attach-role-policy[^\n]*\\\n[^\n]*policy\/PowerUserAccess/);
  // Workload roles: the boundary allows GetSecretValue on the new names.
  const { stageSecretName } = await import(join(ROOT, "infra/stage-secrets.ts"));
  const { stageInfo } = await import(join(ROOT, "infra/config.ts"));
  const allowed = statements(`${BOUNDARY}.json`)
    .filter((s) => s.Effect === "Allow" && [s.Action].flat().includes("secretsmanager:GetSecretValue"))
    .flatMap((s) => [s.Resource].flat());
  for (const stage of ["dev", "prod", "pr-12"]) {
    for (const kind of ["signing", "approval"]) {
      const arn = `arn:aws:secretsmanager:eu-west-3:442123849268:secret:${stageSecretName(stageInfo(stage), kind)}-AbC123`;
      assert.ok(allowed.some((p) => globMatch(p, arn)), `boundary does not allow GetSecretValue on ${arn}`);
    }
  }
  assert.match(section14, /no IAM change/i, "§14 must say whether the owner applies an IAM change");
});
