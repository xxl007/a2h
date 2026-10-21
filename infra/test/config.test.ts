import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALB_IDLE_TIMEOUT_SECONDS,
  SHARED_PARAMETERS,
  sharedParameterName,
  stageInfo,
} from "../config.ts";

test("dev stage: shared owner, public schema, /mcp routing at 49000", () => {
  const s = stageInfo("dev");
  assert.equal(s.kind, "dev");
  assert.equal(s.ownsSharedResources, true);
  assert.equal(s.dbSchema, "public");
  assert.equal(s.mcpBasePath, "/mcp");
  assert.equal(s.healthPath, "/healthz");
  assert.equal(s.storagePrefix, "");
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
  assert.ok(ALB_IDLE_TIMEOUT_SECONDS >= 3600);
  assert.ok(ALB_IDLE_TIMEOUT_SECONDS <= 4000); // AWS maximum
});
