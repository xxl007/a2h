import { test } from "node:test";
import assert from "node:assert/strict";
import { healthPathFor } from "../../apps/mcp/src/health-path.ts";
import { KEEP_ALIVE_TIMEOUT_MS } from "../../apps/mcp/src/http-timeouts.ts";
import {
  ALB_IDLE_TIMEOUT_SECONDS,
  OPEN_NEXT_VERSION,
  PR_STAGE_READS,
  SHARED_PARAMETERS,
  STORAGE_AREAS,
  sharedParameterName,
  stageInfo,
  WORKLOAD_BOUNDARY_POLICY_NAME,
  workloadBoundaryArn,
} from "../config.ts";

test("dev stage: shared owner, public schema, /mcp routing at 49000", () => {
  const s = stageInfo("dev");
  assert.equal(s.kind, "dev");
  assert.equal(s.ownsSharedResources, true);
  assert.equal(s.dbSchema, "public");
  assert.equal(s.mcpBasePath, "/mcp");
  assert.equal(s.healthPath, "/healthz");
  assert.equal(s.storagePrefix, "dev/");
  assert.equal(s.warm, 1);
  assert.deepEqual(s.mcpScaling, { min: 1, max: 2 });
  assert.equal(s.spot, false);
  assert.equal(s.logRetention, "1 month");
  assert.deepEqual(
    s.mcpRules.map((r) => [r.path, r.priority]),
    [
      ["/mcp", 49000],
      ["/mcp/*", 49001],
      ["/healthz", 49002],
    ],
  );
});

test("prod stage: owns everything, one-year logs, warm", () => {
  const s = stageInfo("prod");
  assert.equal(s.kind, "prod");
  assert.equal(s.ownsSharedResources, true);
  assert.equal(s.dbSchema, "public");
  assert.equal(s.storagePrefix, "prod/");
  assert.equal(s.warm, 1);
  assert.equal(s.logRetention, "1 year");
  assert.deepEqual(s.mcpScaling, { min: 1, max: 2 });
});

test("pr-12 stage: borrows shared resources, own schema, path prefix, priority 112", () => {
  const s = stageInfo("pr-12");
  assert.equal(s.kind, "pr");
  assert.equal(s.prNumber, 12);
  assert.equal(s.ownsSharedResources, false);
  assert.equal(s.dbSchema, "pr_12");
  assert.equal(s.mcpBasePath, "/pr-12/mcp");
  assert.equal(s.healthPath, "/pr-12/healthz");
  assert.equal(s.storagePrefix, "pr-12/");
  assert.equal(s.warm, 0);
  assert.equal(s.spot, true);
  assert.deepEqual(s.mcpScaling, { min: 1, max: 1 });
  assert.deepEqual(
    s.mcpRules.map((r) => [r.path, r.priority]),
    [["/pr-12/*", 112]],
  );
  // ECS service names, task families and log groups are per cluster, so
  // components on a pr stage carry the PR number to avoid colliding with dev.
  assert.equal(s.componentSuffix, "Pr12");
});

test("pr priorities stay below the dev/prod range", () => {
  assert.equal(stageInfo("pr-48899").mcpRules[0]?.priority, 48999);
  assert.throws(() => stageInfo("pr-48900"), /PR number/);
});

test("unknown or malformed stages are refused", () => {
  for (const bad of ["frank", "pr-", "pr-0", "pr-01", "pr-1a", "PR-1", "staging"]) {
    assert.throws(() => stageInfo(bad), /stage/, bad);
  }
});

test("the eight shared SSM parameters of the contract", () => {
  assert.deepEqual(Object.values(SHARED_PARAMETERS).map(sharedParameterName), [
    "/a2h/shared/vpc-id",
    "/a2h/shared/cluster-id",
    "/a2h/shared/alb-arn",
    "/a2h/shared/aurora-cluster-id",
    "/a2h/shared/aurora-cluster-arn",
    "/a2h/shared/aurora-secret-arn",
    "/a2h/shared/uploads-bucket",
    "/a2h/shared/email-sender",
  ]);
});

test("ALB idle timeout keeps an idle MCP stream open for over an hour", () => {
  // Spec mcp-transport, scenario "Idle stream survives" (61 minutes idle).
  // 61 minutes = 3660 s idle, so 3600 would cut it: use the AWS maximum.
  assert.equal(ALB_IDLE_TIMEOUT_SECONDS, 4000);
  assert.ok(ALB_IDLE_TIMEOUT_SECONDS > 61 * 60);
});

test("the MCP server's keep-alive outlasts the ALB idle timeout", () => {
  // apps/mcp/src/http-timeouts.ts: the ALB must close idle target
  // connections before Node does, or it may reuse a closing socket (502).
  assert.ok(KEEP_ALIVE_TIMEOUT_MS > ALB_IDLE_TIMEOUT_SECONDS * 1000);
});

test("workload permissions boundary: policy name and ARN from the caller's account", () => {
  // Contract amendment 1: deploy roles may create role/a2h-* only with this boundary.
  assert.equal(WORKLOAD_BOUNDARY_POLICY_NAME, "a2h-workload-boundary");
  assert.equal(
    workloadBoundaryArn("123456789012"),
    "arn:aws:iam::123456789012:policy/a2h-workload-boundary",
  );
  for (const bad of ["", "12345678901", "1234567890123", "12345678901a", "123456789012 "]) {
    assert.throws(() => workloadBoundaryArn(bad), /account/, JSON.stringify(bad));
  }
});

test("pr stages read only the shared identifiers they use, never the Aurora master secret", () => {
  assert.deepEqual(PR_STAGE_READS, [
    "vpcId",
    "clusterId",
    "albArn",
    "auroraClusterId",
    "uploadsBucket",
    "emailSender",
  ]);
  assert.ok(!PR_STAGE_READS.includes("auroraSecretArn"));
});

test("storage areas match the lifecycle prefixes", () => {
  assert.deepEqual(STORAGE_AREAS, ["uploads", "tmp"]);
});

test("every stage has a non-empty storage prefix, and no stage's prefix contains another's", () => {
  // A dev object under uploads/pr-<n>/... must never be reachable by a
  // preview's grant on uploads/pr-<n>/*: so dev and prod keys live under
  // dev/ and prod/, never at the area root.
  const stages = ["dev", "prod", "pr-1", "pr-12", "pr-120", "pr-48899"].map(stageInfo);
  for (const s of stages) {
    assert.match(s.storagePrefix, /^[a-z0-9-]+\/$/, s.name);
    assert.equal(s.storagePrefix, `${s.name}/`, s.name);
  }
  for (const a of stages) {
    for (const b of stages) {
      if (a === b) continue;
      assert.ok(!b.storagePrefix.startsWith(a.storagePrefix), `${a.name} prefix covers ${b.name}`);
    }
  }
});

test("one health-path source: the stage model and the MCP server agree", () => {
  // apps/mcp/src/health-path.ts is the only derivation; infra imports it.
  for (const stage of ["dev", "prod", "pr-12"]) {
    const s = stageInfo(stage);
    assert.equal(s.healthPath, healthPathFor(s.mcpBasePath), stage);
  }
  assert.equal(stageInfo("dev").healthPath, "/healthz");
  assert.equal(healthPathFor("/mcp"), "/healthz");
  assert.equal(stageInfo("pr-12").healthPath, "/pr-12/healthz");
  assert.equal(healthPathFor("/pr-12/mcp"), "/pr-12/healthz");
});

test("OpenNext pinned to 4.1.12, the first release that builds Next 15.5.x without the unsupported-version flag", () => {
  assert.equal(OPEN_NEXT_VERSION, "4.1.12");
  const parts = OPEN_NEXT_VERSION.split(".").map(Number);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((n) => Number.isInteger(n) && n >= 0), `not a plain semver: ${OPEN_NEXT_VERSION}`);
  const [major, minor, patch] = parts as [number, number, number];
  const atLeast = (a: [number, number, number], b: [number, number, number]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
  assert.ok(atLeast([major, minor, patch], [4, 1, 12]), `${OPEN_NEXT_VERSION} < 4.1.12`);
});
