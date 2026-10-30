import { test } from "node:test";
import assert from "node:assert/strict";
import { healthPathFor } from "../../apps/mcp/src/health-path.ts";
import { KEEP_ALIVE_TIMEOUT_MS } from "../../apps/mcp/src/http-timeouts.ts";
import { PrincipalSchema, ValidationPolicySchema } from "../../packages/protocol/src/index.ts";
import {
  ALB_IDLE_TIMEOUT_SECONDS,
  ALLOWLIST_NONE,
  allowlistParameterName,
  allowlistReadPermission,
  CLEARING_SHARE,
  DEVELOPMENT_POLICY,
  developmentPrincipal,
  FEE_RATE,
  limitsFor,
  OPEN_NEXT_VERSION,
  PR_STAGE_OPTIONAL_READS,
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
      // Path-aware protected-resource metadata (RFC 9728; m1-hosted-connector D3, task 8.1).
      ["/.well-known/oauth-protected-resource/mcp", 49003],
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
  assert.deepEqual(s.mcpRules, stageInfo("dev").mcpRules);
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
    [
      ["/pr-12/*", 112],
      ["/.well-known/oauth-protected-resource/pr-12/mcp", 20012],
    ],
  );
  // ECS service names, task families and log groups are per cluster, so
  // components on a pr stage carry the PR number to avoid colliding with dev.
  assert.equal(s.componentSuffix, "Pr12");
});

test("pr priorities: two disjoint bands below the dev/prod range, refused past pr-19899", () => {
  // Band 1: `/pr-<n>/*` at 100 + n (100..19999). Band 2: the metadata path at
  // 20000 + n (20001..39899). dev/prod: 49000-49003. AWS allows 1-50000.
  const shared = new Set(stageInfo("dev").mcpRules.map((r) => r.priority));
  const seen = new Map<number, string>();
  for (const n of [1, 2, 12, 99, 100, 9999, 19899]) {
    const rules = stageInfo(`pr-${n}`).mcpRules;
    assert.deepEqual(
      rules.map((r) => r.priority),
      [100 + n, 20000 + n],
      `pr-${n}`,
    );
    for (const r of rules) {
      assert.ok(r.priority >= 1 && r.priority < 49000, `pr-${n} ${r.priority}`);
      assert.ok(!shared.has(r.priority), `pr-${n} collides with dev/prod at ${r.priority}`);
      assert.equal(seen.get(r.priority), undefined, `pr-${n} ${r.path} collides with ${seen.get(r.priority)}`);
      seen.set(r.priority, `pr-${n} ${r.path}`);
    }
  }
  // The two bands never meet: the highest band-1 priority is below the lowest band-2 one.
  assert.ok(100 + 19899 < 20000 + 1);
  assert.throws(() => stageInfo("pr-19900"), /PR number/);
  assert.throws(() => stageInfo("pr-48899"), /PR number/);
});

// apps/mcp/src/auth.ts, loaded at run time only: its SDK types (DOM `URL`)
// do not typecheck under infra's `types: ["node"]`, so tsc must not follow it.
const MCP_AUTH_MODULE: string = "../../apps/mcp/src/auth.ts";
interface McpAuthModule {
  createGate: (config: Record<string, unknown>, verifier: unknown) => { metadataPath: string };
}

test("the metadata path of every stage is the one the MCP server answers (one derivation, RFC 9728)", async () => {
  // apps/mcp derives it from the resource URL with the SDK's
  // getOAuthProtectedResourceMetadataUrl (createGate().metadataPath).
  const { createGate } = (await import(MCP_AUTH_MODULE)) as McpAuthModule;
  const verifier = { verifyAccessToken: () => Promise.reject(new Error("unused")) };
  for (const s of ["dev", "prod", "pr-12"]) {
    const stage = stageInfo(s);
    const gate = createGate(
      {
        required: true,
        issuer: "https://dev.a2h-protocol.org/api/auth",
        jwksUrl: "https://dev.a2h-protocol.org/api/auth/jwks",
        resourceUrl: `https://mcp.dev.a2h-protocol.org${stage.mcpBasePath}`,
        pingOpen: false,
      },
      verifier,
    );
    assert.equal(stage.metadataPath, gate.metadataPath, s);
    assert.ok(stage.mcpRules.some((r) => r.path === gate.metadataPath), `${s}: no ALB rule for ${gate.metadataPath}`);
  }
});

test("unknown or malformed stages are refused", () => {
  for (const bad of ["frank", "pr-", "pr-0", "pr-01", "pr-1a", "PR-1", "staging"]) {
    assert.throws(() => stageInfo(bad), /stage/, bad);
  }
});

test("the nine shared SSM parameters of the contract", () => {
  assert.deepEqual(Object.values(SHARED_PARAMETERS).map(sharedParameterName), [
    "/a2h/shared/vpc-id",
    "/a2h/shared/cluster-id",
    "/a2h/shared/alb-arn",
    "/a2h/shared/aurora-cluster-id",
    "/a2h/shared/aurora-cluster-arn",
    "/a2h/shared/aurora-secret-arn",
    "/a2h/shared/uploads-bucket",
    "/a2h/shared/email-sender",
    // m1-hosted-connector D5: dev's CloudFront-scope web ACL, attached to every preview's distribution.
    "/a2h/shared/web-acl-cloudfront-arn",
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
  // dev's CloudFront web ACL: read when dev has published it (first dev deploy after task 8.1), else the preview's web has none.
  assert.deepEqual(PR_STAGE_OPTIONAL_READS, ["webAclCloudfrontArn"]);
  assert.ok(!PR_STAGE_OPTIONAL_READS.some((k) => PR_STAGE_READS.includes(k)));
});

test("storage areas match the lifecycle prefixes", () => {
  assert.deepEqual(STORAGE_AREAS, ["uploads", "tmp"]);
});

test("every stage has a non-empty storage prefix, and no stage's prefix contains another's", () => {
  // A dev object under uploads/pr-<n>/... must never be reachable by a
  // preview's grant on uploads/pr-<n>/*: so dev and prod keys live under
  // dev/ and prod/, never at the area root.
  const stages = ["dev", "prod", "pr-1", "pr-12", "pr-120", "pr-19899"].map(stageInfo);
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

// m1-protocol-connector design D3, D7; task 6.1.
test("pg-boss schema per stage: pgboss on dev and prod, pr_<n>_jobs on previews (D3)", () => {
  assert.equal(stageInfo("dev").jobsSchema, "pgboss");
  assert.equal(stageInfo("prod").jobsSchema, "pgboss");
  assert.equal(stageInfo("pr-12").jobsSchema, "pr_12_jobs");
  for (const s of ["dev", "prod", "pr-12", "pr-19899"]) {
    const { dbSchema, jobsSchema } = stageInfo(s);
    assert.notEqual(jobsSchema, dbSchema, s);
    assert.match(jobsSchema, /^[a-z_][a-z0-9_]{0,62}$/, s);
  }
});

test("the simulator is enabled on dev and previews, never on prod", () => {
  assert.equal(stageInfo("dev").simulatorEnabled, true);
  assert.equal(stageInfo("pr-12").simulatorEnabled, true);
  assert.equal(stageInfo("prod").simulatorEnabled, false);
});

test("development principal per stage: dev-principal-<stage>, verified organisation (D7)", () => {
  for (const s of ["dev", "prod", "pr-12"]) {
    assert.deepEqual(developmentPrincipal(stageInfo(s)), {
      principal_id: `dev-principal-${s}`,
      identity_mode: "verified_organisation",
      verified: true,
    });
  }
});

test("fee rate and clearing share are configuration in [0, 1) and [0, 1] (ADR 0002)", () => {
  assert.ok(FEE_RATE >= 0 && FEE_RATE < 1);
  assert.ok(CLEARING_SHARE >= 0 && CLEARING_SHARE <= 1);
  // The policy carries the same fee rate the services receive.
  assert.equal(DEVELOPMENT_POLICY.fee_rate, FEE_RATE);
  for (const k of ["monthly_budget_minor", "per_request_cap_minor", "daily_request_limit", "throttled_daily_limit"] as const) {
    assert.ok(Number.isSafeInteger(DEVELOPMENT_POLICY[k]) && DEVELOPMENT_POLICY[k] >= 0, k);
  }
  assert.ok(DEVELOPMENT_POLICY.per_request_cap_minor <= DEVELOPMENT_POLICY.monthly_budget_minor);
  assert.ok(DEVELOPMENT_POLICY.throttled_daily_limit <= DEVELOPMENT_POLICY.daily_request_limit);
});

test("the policy and the principal are valid packages/protocol shapes (no duplicated schema)", () => {
  assert.deepEqual(ValidationPolicySchema.parse(DEVELOPMENT_POLICY), DEVELOPMENT_POLICY);
  for (const s of ["dev", "prod", "pr-19899"]) {
    const principal = developmentPrincipal(stageInfo(s));
    assert.deepEqual(PrincipalSchema.parse(principal), principal, s);
  }
});

// m1-hosted-connector design D5, D7; tasks 8.1 and 8.2.
test("stage limits are configuration: test stages 600/20000, prod 60/2000, 4 held pings, edge 600 per 5 minutes", () => {
  assert.deepEqual(
    ["dev", "pr-12", "prod"].map((s) => [s, limitsFor(stageInfo(s))]),
    [
      ["dev", { perMinute: 600, perDay: 20000, pingMaxConcurrent: 4, edgeRequestsPer5Minutes: 600 }],
      ["pr-12", { perMinute: 600, perDay: 20000, pingMaxConcurrent: 4, edgeRequestsPer5Minutes: 600 }],
      ["prod", { perMinute: 60, perDay: 2000, pingMaxConcurrent: 4, edgeRequestsPer5Minutes: 600 }],
    ],
  );
  for (const s of ["dev", "prod", "pr-12"]) {
    const l = limitsFor(stageInfo(s));
    for (const v of Object.values(l)) assert.ok(Number.isSafeInteger(v) && v > 0, `${s} ${v}`);
    assert.ok(l.perMinute <= l.perDay, s);
    // AWS WAF rate-based rules accept 10 to 2,000,000,000 requests per window.
    assert.ok(l.edgeRequestsPer5Minutes >= 10 && l.edgeRequestsPer5Minutes <= 2_000_000_000, s);
  }
  // A fresh copy each time: a caller cannot change another stage's limits.
  const a = limitsFor(stageInfo("dev"));
  a.perMinute = 1;
  assert.equal(limitsFor(stageInfo("dev")).perMinute, 600);
});

test("allow-list parameter per environment (D7): dev and previews share one, prod has its own; only dev and prod create it", () => {
  assert.equal(allowlistParameterName(stageInfo("dev")), "/a2h/shared/principal-allowlist");
  assert.equal(allowlistParameterName(stageInfo("pr-12")), "/a2h/shared/principal-allowlist");
  assert.equal(allowlistParameterName(stageInfo("prod")), "/a2h/prod/principal-allowlist");
  // SSM refuses empty values: the deploy writes this marker for "nobody yet".
  assert.equal(ALLOWLIST_NONE, "none");
  assert.deepEqual(allowlistReadPermission(stageInfo("pr-12"), "123456789012"), {
    actions: ["ssm:GetParameter"],
    resources: ["arn:aws:ssm:eu-west-3:123456789012:parameter/a2h/shared/principal-allowlist"],
  });
  assert.deepEqual(allowlistReadPermission(stageInfo("prod"), "123456789012").resources, [
    "arn:aws:ssm:eu-west-3:123456789012:parameter/a2h/prod/principal-allowlist",
  ]);
  assert.throws(() => allowlistReadPermission(stageInfo("dev"), "nope"), /account/);
});
