// Structural tests for .github/workflows: properties a reviewer would
// otherwise have to re-check by eye on every change to a workflow.
// The YAML is parsed (yaml, YAML 1.2: `on` stays a string key), never executed.
// Spec: openspec/.../preview-environments/spec.md ("CI gates every PR",
// "PR closed", "Secrets inventory") and contract amendment 1.
// Run: node --test tests/ci/workflows.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";
import YAML from "yaml";

const WORKFLOWS = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
const text = Object.fromEntries(files.map((f) => [f, readFileSync(join(WORKFLOWS, f), "utf8")]));
const wf = Object.fromEntries(files.map((f) => [f, YAML.parse(text[f])]));

const TEARDOWN_CALL = "./.github/workflows/preview-teardown.yml";
const PREVIEW_GROUP = "preview-pr-${{ github.event.pull_request.number }}";

const jobs = (f) => Object.entries(wf[f]?.jobs ?? {});
const steps = (job) => job.steps ?? [];
const runs = (step, needle) => typeof step.run === "string" && step.run.includes(needle);
const needsOf = (job) => [job.needs ?? []].flat();
const indexOf = (job, pred, what) => {
  const i = steps(job).findIndex(pred);
  assert.notEqual(i, -1, `step not found: ${what}`);
  return i;
};
/** Jobs, across all workflows, that have a step running <needle>. */
const jobsRunning = (needle) =>
  files.flatMap((f) => jobs(f).filter(([, j]) => steps(j).some((s) => runs(s, needle))).map(([id, j]) => ({ f, id, j })));
const callers = (f, target) => jobs(f).filter(([, j]) => j.uses === target);

test("the workflows this suite relies on exist", () => {
  for (const f of ["ci.yml", "deploy.yml", "preview.yml", "teardown.yml", "preview-teardown.yml"]) {
    assert.ok(files.includes(f), `.github/workflows/${f} missing`);
  }
});

test("every uses: is a same-commit local path or pinned to a 40-hex commit SHA", () => {
  const bad = [];
  for (const f of files) {
    for (const [id, j] of jobs(f)) {
      const all = [j.uses, ...steps(j).map((s) => s.uses)].filter((u) => u !== undefined);
      for (const u of all) {
        if (u.startsWith("./")) continue; // resolved from the workflow's own commit
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(u)) bad.push(`${f} ${id}: ${u}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("no secrets.AWS* and no long-lived AWS key inputs in any workflow", () => {
  for (const f of files) {
    assert.doesNotMatch(text[f], /secrets\.AWS/i, `${f} references secrets.AWS*`);
    assert.doesNotMatch(text[f], /aws-(access-key-id|secret-access-key)\s*:/i, `${f} passes an AWS key`);
  }
});

test("every job that runs sst deploy needs the check job, which is ci.yml", () => {
  const deployers = jobsRunning("sst deploy");
  assert.deepEqual(deployers.map(({ f }) => f).sort(), ["deploy.yml", "preview.yml"]);
  for (const { f, id, j } of deployers) {
    assert.ok(needsOf(j).includes("check"), `${f} ${id} does not need check`);
    assert.equal(wf[f].jobs.check?.uses, "./.github/workflows/ci.yml", `${f} check is not ci.yml`);
  }
});

test("deploy.yml assumes vars.AWS_DEV_ROLE_ARN; preview and teardown assume vars.AWS_PREVIEW_ROLE_ARN", () => {
  const roles = (f) =>
    jobs(f).flatMap(([, j]) =>
      steps(j).filter((s) => s.uses?.startsWith("aws-actions/configure-aws-credentials@")).map((s) => s.with?.["role-to-assume"]),
    );
  assert.deepEqual(roles("deploy.yml"), ["${{ vars.AWS_DEV_ROLE_ARN }}"]);
  assert.deepEqual(roles("preview.yml"), ["${{ vars.AWS_PREVIEW_ROLE_ARN }}"]);
  assert.deepEqual(roles("preview-teardown.yml"), ["${{ vars.AWS_PREVIEW_ROLE_ARN }}"]);
  // teardown.yml gets its credentials only through preview-teardown.yml.
  assert.deepEqual(roles("teardown.yml"), []);
  assert.doesNotMatch(text["deploy.yml"], /vars\.AWS_PREVIEW_ROLE_ARN/);
  for (const f of ["preview.yml", "teardown.yml", "preview-teardown.yml"]) {
    assert.doesNotMatch(text[f], /vars\.AWS_DEV_ROLE_ARN/, `${f} uses the dev role`);
  }
});

test("the teardown sequence is defined once, in preview-teardown.yml, and both teardown.yml and preview.yml call it", () => {
  assert.deepEqual(Object.keys(wf["preview-teardown.yml"].on ?? {}), ["workflow_call"]);
  for (const needle of ["sst remove", "pr-schema.sh drop"]) {
    assert.deepEqual(
      jobsRunning(needle).map(({ f }) => f),
      ["preview-teardown.yml"],
      `${needle} must run only in preview-teardown.yml`,
    );
  }
  assert.equal(callers("teardown.yml", TEARDOWN_CALL).length, 1, "teardown.yml does not call preview-teardown.yml");
  for (const f of ["teardown.yml", "preview.yml"]) {
    for (const [id, j] of callers(f, TEARDOWN_CALL)) {
      for (const p of ["id-token", "pull-requests"]) {
        assert.equal(j.permissions?.[p], "write", `${f} ${id} does not grant ${p}: write`);
      }
    }
  }
});

test("preview and teardown share one concurrency group per PR, never cancelled in progress", () => {
  const deploy = jobsRunning("sst deploy").find(({ f }) => f === "preview.yml");
  const teardown = jobsRunning("sst remove").find(({ f }) => f === "preview-teardown.yml");
  assert.ok(deploy && teardown);
  for (const { f, id, j } of [deploy, teardown]) {
    assert.equal(j.concurrency?.group, PREVIEW_GROUP, `${f} ${id} concurrency group`);
    assert.equal(j.concurrency?.["cancel-in-progress"], false, `${f} ${id} cancel-in-progress`);
  }
});

test("teardown runs sst remove before pr-schema.sh drop, and the drop runs even if the remove failed", () => {
  const { j } = jobsRunning("sst remove").find(({ f }) => f === "preview-teardown.yml");
  const remove = indexOf(j, (s) => runs(s, "sst remove"), "sst remove");
  const drop = indexOf(j, (s) => runs(s, "pr-schema.sh drop"), "pr-schema.sh drop");
  assert.ok(remove < drop, "sst remove must come before pr-schema.sh drop");
  assert.equal(steps(j)[remove]["continue-on-error"], true, "a failed remove must not stop the drop");
  const dropIf = String(steps(j)[drop].if ?? "");
  assert.match(dropIf, /!cancelled\(\)/, "drop must run after a failed remove");
  const removeId = steps(j)[remove].id;
  if (removeId) assert.ok(!dropIf.includes(`steps.${removeId}.outcome == 'success'`), "drop must not require a successful remove");
  // The run reports the result on the PR and turns red when incomplete.
  assert.ok(steps(j).some((s) => s.uses?.startsWith("marocchino/sticky-pull-request-comment@")), "no PR comment");
  assert.ok(steps(j).some((s) => runs(s, "exit 1") && String(s.if ?? "").includes("always()")), "no failing step");
});

test("preview re-reads the PR state after creating the login and before sst deploy", () => {
  const { j } = jobsRunning("sst deploy").find(({ f }) => f === "preview.yml");
  const isStateRead = (s) => runs(s, "gh api") && runs(s, "/pulls/") && runs(s, ".state");
  const create = indexOf(j, (s) => runs(s, "pr-schema.sh create"), "pr-schema.sh create");
  const deploy = indexOf(j, (s) => runs(s, "sst deploy"), "sst deploy");
  const reads = steps(j).map((s, i) => (isStateRead(s) ? i : -1)).filter((i) => i >= 0);
  assert.ok(reads[0] < create, "the PR state is not read before the login is created");
  const reread = reads.filter((i) => i > create && i < deploy).at(-1);
  assert.ok(reread !== undefined, "the PR state is not re-read between create and sst deploy");
  const id = steps(j)[reread].id;
  assert.ok(id, "the re-read step has no id");
  assert.match(String(steps(j)[deploy].if ?? ""), new RegExp(`steps\\.${id}\\.outputs\\.open == 'true'`));
});

test("a preview run that finds the PR not open, at either check, runs the teardown instead of skipping", () => {
  const { id: deployId, j } = jobsRunning("sst deploy").find(({ f }) => f === "preview.yml");
  const checks = steps(j).filter((s) => runs(s, "gh api") && runs(s, "/pulls/") && runs(s, ".state"));
  assert.equal(checks.length, 2, "expected two PR state checks");
  for (const s of checks) {
    assert.ok(s.id, "state check without id");
    assert.match(s.run, /open=false/, `step ${s.id} does not report open=false`);
  }
  const closed = String(j.outputs?.closed ?? "");
  for (const s of checks) {
    assert.ok(closed.includes(`steps.${s.id}.outputs.open == 'false'`), `outputs.closed ignores ${s.id}`);
  }
  const calls = callers("preview.yml", TEARDOWN_CALL);
  assert.equal(calls.length, 1, "preview.yml does not call preview-teardown.yml");
  const [[cid, c]] = calls;
  assert.ok(needsOf(c).includes(deployId), `${cid} does not need ${deployId}`);
  assert.match(String(c.if ?? ""), new RegExp(`needs\\.${deployId}\\.outputs\\.closed == 'true'`));
  assert.match(String(c.if ?? ""), /!cancelled\(\)/);
});

// --- PR state reads: retried, fail closed, and re-read by the teardown -------
// Every step that reads the PR state (`gh api .../pulls/<n> --jq .state`) is
// extracted from the YAML and executed with bash the way the runner does
// (bash --noprofile --norc -eo pipefail), against a fake gh and a fake sleep.

const isStateRead = (s) => runs(s, "gh api") && runs(s, "/pulls/") && runs(s, ".state");
const teardownJob = () => jobsRunning("sst remove").find(({ f }) => f === "preview-teardown.yml").j;
/** [{ f, id, s, key }] for every state-read step; key is the output it sets. */
const stateReads = () =>
  files.flatMap((f) =>
    jobs(f).flatMap(([, j]) =>
      steps(j)
        .filter(isStateRead)
        .map((s) => ({ f, id: s.id, s, key: f === "preview-teardown.yml" ? "proceed" : "open" })),
    ),
  );

function runStateRead(script, { fails = 0, state = "closed", env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a2h-state-read-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        `n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/count"`,
        `if [ "$n" -le "$FAKE_GH_FAILS" ]; then echo "gh: HTTP 502: Bad Gateway" >&2; exit 1; fi`,
        `printf '%s\\n' "$FAKE_GH_STATE"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "sleep"), `#!/usr/bin/env bash\necho "$1" >> "${dir}/sleeps"\n`, { mode: 0o755 });
    writeFileSync(join(dir, "step.sh"), script);
    writeFileSync(join(dir, "out"), "");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "example/a2h",
        GITHUB_OUTPUT: join(dir, "out"),
        PR_NUMBER: "42",
        FAKE_GH_FAILS: String(fails),
        FAKE_GH_STATE: state,
        ...env,
      },
    });
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
    return {
      status: r.status,
      stdout: r.stdout + r.stderr,
      out: read("out").trim(),
      calls: Number(read("count") || 0),
      sleeps: read("sleeps").split("\n").filter(Boolean).map(Number),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("there are three PR state reads: two in preview.yml, one in preview-teardown.yml; none interpolates ${{ }}", () => {
  const reads = stateReads();
  assert.deepEqual(reads.map(({ f }) => f).sort(), ["preview-teardown.yml", "preview.yml", "preview.yml"]);
  for (const { f, id, s } of reads) {
    assert.ok(id, `${f}: state read without id`);
    assert.doesNotMatch(s.run, /\$\{\{/, `${f} ${id}: pass values through env, not \${{ }} in run`);
  }
});

test("every PR state read retries a transient gh failure, with backoff, and then succeeds", () => {
  for (const { f, id, s, key } of stateReads()) {
    const env = { REQUIRE_CLOSED: "true" };
    const r = runStateRead(s.run, { fails: 4, state: "closed", env });
    assert.equal(r.status, 0, `${f} ${id} did not survive 4 transient failures:\n${r.stdout}`);
    assert.equal(r.calls, 5, `${f} ${id}: expected 5 gh calls, got ${r.calls}`);
    assert.equal(r.sleeps.length, 4, `${f} ${id}: expected 4 waits between attempts`);
    for (let i = 1; i < r.sleeps.length; i++) assert.ok(r.sleeps[i] > r.sleeps[i - 1], `${f} ${id}: no backoff ${r.sleeps}`);
    assert.equal(r.out, key === "open" ? "open=false" : "proceed=true", `${f} ${id} output`);
  }
});

test("every PR state read fails the step, loudly and with no output, when gh never answers", () => {
  for (const [label, opts] of [
    ["gh always fails", { fails: 99 }],
    ["gh answers nothing", { state: "" }],
    ["gh answers an unknown state", { state: "merged-ish" }],
  ]) {
    for (const { f, id, s } of stateReads()) {
      const r = runStateRead(s.run, { ...opts, env: { REQUIRE_CLOSED: "true" } });
      assert.notEqual(r.status, 0, `${f} ${id} (${label}) must fail, not assume a state`);
      assert.equal(r.out, "", `${f} ${id} (${label}) wrote outputs: ${r.out}`);
      assert.equal(r.calls, 5, `${f} ${id} (${label}): expected 5 attempts, got ${r.calls}`);
      assert.match(r.stdout, /::error::/, `${f} ${id} (${label}) does not report an ::error::`);
    }
  }
});

test("preview.yml state reads report open=true for an open PR", () => {
  for (const { id, s } of stateReads().filter(({ f }) => f === "preview.yml")) {
    const r = runStateRead(s.run, { state: "open" });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.out, "open=true", `${id} output`);
    assert.equal(r.calls, 1);
  }
});

test("a preview run whose state read failed hands over to the teardown, which decides on its own re-read", () => {
  const { j } = jobsRunning("sst deploy").find(({ f }) => f === "preview.yml");
  const closed = String(j.outputs?.closed ?? "");
  for (const s of steps(j).filter(isStateRead)) {
    assert.ok(closed.includes(`steps.${s.id}.outcome == 'failure'`), `outputs.closed ignores a failed ${s.id}`);
  }
});

test("preview-teardown.yml takes a require-closed input; preview.yml passes true, teardown.yml does not", () => {
  const input = wf["preview-teardown.yml"].on?.workflow_call?.inputs?.["require-closed"];
  assert.ok(input, "preview-teardown.yml has no require-closed input");
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  const [[, fromPreview]] = callers("preview.yml", TEARDOWN_CALL);
  assert.equal(fromPreview.with?.["require-closed"], true, "preview.yml must pass require-closed: true");
  const [[, fromClosed]] = callers("teardown.yml", TEARDOWN_CALL);
  assert.notEqual(fromClosed.with?.["require-closed"], true, "teardown.yml (closed event) must not require a re-read");
});

test("called with require-closed, the teardown re-reads the state first and touches nothing for an open PR", () => {
  const j = teardownJob();
  const gate = steps(j)[0];
  assert.ok(isStateRead(gate), "the first step of the teardown job is not the PR state read");
  assert.ok(gate.id, "the state read has no id");
  assert.match(String(gate.env?.REQUIRE_CLOSED ?? ""), /inputs\.require-closed/, "REQUIRE_CLOSED is not the input");
  const proceed = `steps.${gate.id}.outputs.proceed == 'true'`;
  for (const [i, s] of steps(j).entries()) {
    if (i === 0) continue;
    assert.ok(String(s.if ?? "").includes(proceed), `step ${s.name ?? s.uses} is not gated on ${proceed}`);
  }
  // Behaviour of the gate itself.
  const open = runStateRead(gate.run, { state: "open", env: { REQUIRE_CLOSED: "true" } });
  assert.equal(open.status, 0, open.stdout);
  assert.equal(open.out, "proceed=false", "an open PR must not be torn down");
  const closedPr = runStateRead(gate.run, { state: "closed", env: { REQUIRE_CLOSED: "true" } });
  assert.equal(closedPr.out, "proceed=true");
  const fromClosedEvent = runStateRead(gate.run, { fails: 99, env: { REQUIRE_CLOSED: "false" } });
  assert.equal(fromClosedEvent.status, 0, fromClosedEvent.stdout);
  assert.equal(fromClosedEvent.out, "proceed=true", "teardown.yml's behaviour must not change");
  assert.equal(fromClosedEvent.calls, 0, "teardown.yml's run must not depend on the GitHub API");
});
