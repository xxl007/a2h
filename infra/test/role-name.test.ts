import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_NAME_MAX, roleName } from "../config.ts";

// IAM role names: 1-64 characters from [A-Za-z0-9+=,.@_-].
const IAM_ROLE_NAME = /^[A-Za-z0-9+=,.@_-]{1,64}$/;

// The longest stage we allow: listener priority 100 + n must stay below
// 49000 (config.ts stageInfo), so n <= 48899.
const LONGEST_STAGE = "pr-48899";
const STAGES = ["dev", "prod", "pr-1", "pr-12", LONGEST_STAGE];

// Logical names of every role SST 4.17.2 creates for our components, computed
// from .sst/platform/src/components/aws/ for stage pr-48899 (componentSuffix
// "Pr48899"; the Web component has no suffix; region eu-west-3 gives
// logicalName("eu-west-3") = "Euwest3").
const SST_ROLES = {
  // fargate.ts:991 createTaskRole / :1023 createExecutionRole, `${name}TaskRole`
  mcpTask: "McpPr48899TaskRole",
  mcpExecution: "McpPr48899ExecutionRole",
  workerTask: "WorkerPr48899TaskRole",
  workerExecution: "WorkerPr48899ExecutionRole",
  // ssr-site.ts:1469 Function `${name}Server${logicalName(region)}` -> function.ts:2277 `${name}Role`
  webServer: "WebServerEuwest3Role",
  // ssr-site.ts:1606 Function `${name}ImageOptimizer`
  webImageOptimizer: "WebImageOptimizerRole",
  // ssr-site.ts:1549 Cron `${name}Warmer${region}` -> cron.ts:294 `${name}Handler`
  webWarmer: "WebWarmerEuwest3HandlerRole",
  // nextjs.ts:959 Function `${name}RevalidationSeeder`
  webSeeder: "WebRevalidationSeederRole",
  // nextjs.ts:867 Queue `${name}RevalidationEvents`; queue.ts:520 subscribe with
  // its constructorName; queue.ts:598-601 `${name}Subscriber${suffix}` where
  // suffix = logicalName(hashStringToPrettyString(queueArn, 6)) (6 chars);
  // queue-lambda-subscriber.ts:62 `${name}Function`; function.ts:2277 `${name}Role`.
  // 49 characters: the longest role name SST generates for this app.
  webRevalidationSubscriber: "WebRevalidationEventsSubscriberXkzrmsFunctionRole",
} as const;

test("revalidation subscriber role keeps the a2h-<stage>- prefix on every stage", () => {
  const logical = SST_ROLES.webRevalidationSubscriber;
  assert.equal(logical.length, 49);
  for (const stage of STAGES) {
    const n = roleName(stage, logical);
    assert.ok(n.startsWith(`a2h-${stage}-`), `${stage}: ${n}`);
    assert.ok(n.length <= ROLE_NAME_MAX, `${stage}: ${n} is ${n.length} chars`);
    assert.match(n, IAM_ROLE_NAME);
  }
  // SST's own physicalName(64, …) would give "a-dev-…", "prod-…", "pr-12-…".
  assert.equal(roleName("pr-48899", logical).length, 64);
});

test("every role SST creates for our components: a2h-<stage>-, <= 64, IAM-legal", () => {
  for (const stage of STAGES) {
    for (const [key, logical] of Object.entries(SST_ROLES)) {
      const n = roleName(stage, logical);
      assert.ok(n.startsWith(`a2h-${stage}-`), `${key} on ${stage}: ${n}`);
      assert.ok(n.length <= ROLE_NAME_MAX, `${key} on ${stage}: ${n.length}`);
      assert.match(n, IAM_ROLE_NAME, `${key} on ${stage}: ${n}`);
    }
  }
});

test("all role names on one stage are distinct, case-insensitively (IAM ignores case)", () => {
  for (const stage of STAGES) {
    const names = Object.values(SST_ROLES).map((l) => roleName(stage, l).toLowerCase());
    assert.equal(new Set(names).size, names.length, stage);
  }
});

test("two long names sharing a prefix past the truncation point stay distinct", () => {
  const shared = "WebRevalidationEventsSubscriberXkzrmsFunction";
  const a = roleName(LONGEST_STAGE, `${shared}RoleA`);
  const b = roleName(LONGEST_STAGE, `${shared}RoleB`);
  // Same readable head: the difference is past the truncation point.
  assert.equal(a.slice(0, -9), b.slice(0, -9));
  assert.notEqual(a, b);
  assert.notEqual(a.toLowerCase(), b.toLowerCase());
  // Names that differ only by characters the readable part drops.
  assert.notEqual(roleName("dev", "Web-Server"), roleName("dev", "WebServer"));
  // Names that differ only by case.
  assert.notEqual(roleName("dev", "webserverrole").toLowerCase(), roleName("dev", "WebServerRole").toLowerCase());
});

test("stable: same input, same output; pinned values must never change after the first deploy", () => {
  for (const stage of STAGES) {
    for (const logical of Object.values(SST_ROLES)) {
      assert.equal(roleName(stage, logical), roleName(stage, logical));
    }
  }
  // Pinned. Changing roleName() renames (or, for roles SST did not name,
  // replaces) deployed roles: see infra/README.md before editing these.
  assert.equal(roleName("dev", "McpTaskRole"), "a2h-dev-McpTaskRole-be23f65f");
  assert.equal(
    roleName(LONGEST_STAGE, SST_ROLES.webRevalidationSubscriber),
    "a2h-pr-48899-WebRevalidationEventsSubscriberXkzrmsFunct-e3173c96",
  );
});

test("readable part keeps only alphanumerics; short names are not padded", () => {
  assert.match(roleName("dev", "Web Server/Role"), /^a2h-dev-WebServerRole-[0-9a-f]{8}$/);
});

test("rejects unknown stages and empty logical names", () => {
  assert.throws(() => roleName("staging", "McpTaskRole"), /Unknown stage/);
  assert.throws(() => roleName("pr-0", "McpTaskRole"), /Unknown stage/);
  assert.throws(() => roleName("dev", ""), /logical name/);
  assert.throws(() => roleName("dev", "---"), /logical name/);
});
