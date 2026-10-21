// Stage model and constants for the A2H stacks. Pure: no SST globals, no I/O,
// so it is unit-tested with `node --test` (infra/test/config.test.ts).
// Contract: openspec/changes/m0-foundation/tasks.md §Step 4 and amendment 1.
// The health path comes from apps/mcp (pure, no SST), the one derivation.
import { healthPathFor } from "../apps/mcp/src/health-path.ts";

export const APP_NAME = "a2h";
export const REGION = "eu-west-3";

/**
 * Permissions boundary carried by every IAM role this app creates (contract
 * amendment 1). The policy itself is created by the owner's bootstrap
 * (infra/bootstrap/); it denies all IAM and STS role assumption. The deploy
 * roles may create or modify `role/a2h-*` only when this boundary is attached.
 */
export const WORKLOAD_BOUNDARY_POLICY_NAME = "a2h-workload-boundary";

const AWS_ACCOUNT_ID = /^[0-9]{12}$/;

export function assertAccountId(accountId: string): string {
  if (!AWS_ACCOUNT_ID.test(accountId)) {
    throw new Error(`Not an AWS account ID: "${accountId}" (expected 12 digits).`);
  }
  return accountId;
}

/** Boundary ARN for the caller's account; sst.config.ts feeds it the account ID. */
export function workloadBoundaryArn(accountId: string): string {
  assertAccountId(accountId);
  return `arn:aws:iam::${accountId}:policy/${WORKLOAD_BOUNDARY_POLICY_NAME}`;
}

/**
 * Owner-settable. Leave `undefined` until the owner has chosen a domain and
 * created its Route 53 hosted zone (docs/runbooks/aws-bootstrap.md §8).
 * When set, the ALB gets HTTPS on 443 with an 80 -> 443 redirect, and stage
 * hostnames are derived as described in infra/README.md.
 */
export const domain: string | undefined = undefined;

/**
 * Owner-settable. SES sender identity: a domain (preferred) or one address
 * (docs/runbooks/aws-bootstrap.md §9). While `undefined`, no Email component
 * is created and the SSM parameter `email-sender` holds EMAIL_SENDER_NONE.
 */
export const emailSender: string | undefined = undefined;

/** SSM rejects empty values, so "no sender yet" is published as this marker. */
export const EMAIL_SENDER_NONE = "none";

/**
 * Days after which objects under `uploads/` (voice notes, attachments) expire.
 * OPEN: owner to confirm (PRD retention policy).
 */
export const UPLOAD_RETENTION_DAYS = 180;
/** Days after which objects under `tmp/` (unfinished presigned uploads) expire. */
export const TMP_RETENTION_DAYS = 7;

/**
 * Top-level key areas of the uploads bucket. Keys are
 * `<area>/<STORAGE_PREFIX><key>`; lifecycle rules (storage.ts) and the scoped
 * preview grants (access.ts) are both built from this list.
 */
export const STORAGE_AREAS = ["uploads", "tmp"] as const;
export type StorageArea = (typeof STORAGE_AREAS)[number];

/**
 * ALB idle timeout in seconds (AWS range 1-4000). The MCP spec scenario
 * "Idle stream survives" (61 minutes idle, mcp-transport spec) depends on it.
 */
export const ALB_IDLE_TIMEOUT_SECONDS = 3600;

/** Container port of the MCP service (env PORT). */
export const MCP_PORT = 3000;

// Secrets: none in M0. Stripe (M4) and Better Auth (M1) secrets will be
// declared as `new sst.Secret("StripeSecretKey")` / `new sst.Secret("BetterAuthSecret")`
// in a future infra/secrets.ts and linked only to the services that use them.

/** SSM parameters `dev` publishes and `pr-*` reads (contract, tasks.md §Step 4). */
export const SHARED_PARAMETERS = {
  vpcId: "vpc-id",
  clusterId: "cluster-id",
  albArn: "alb-arn",
  auroraClusterId: "aurora-cluster-id",
  auroraClusterArn: "aurora-cluster-arn",
  auroraSecretArn: "aurora-secret-arn",
  uploadsBucket: "uploads-bucket",
  emailSender: "email-sender",
} as const;
export type SharedKey = keyof typeof SHARED_PARAMETERS;
/**
 * What a pr-* stage reads back. The two Aurora ARNs are published for the CI
 * workflows (RDS Data API); the stage itself never reads them, so it never
 * holds a reference to the master secret.
 */
export const PR_STAGE_READS: readonly SharedKey[] = [
  "vpcId",
  "clusterId",
  "albArn",
  "auroraClusterId",
  "uploadsBucket",
  "emailSender",
];
export const SHARED_PREFIX = "/a2h/shared/";
export function sharedParameterName(param: string): string {
  return `${SHARED_PREFIX}${param}`;
}

export interface McpRule {
  path: string;
  priority: number;
}

export interface StageInfo {
  name: string;
  kind: "dev" | "prod" | "pr";
  prNumber?: number;
  /** dev and prod create VPC, cluster, ALB, Aurora, bucket, email; pr-* borrows dev's. */
  ownsSharedResources: boolean;
  dbSchema: string;
  mcpBasePath: string;
  /** ALB health check path: `healthPathFor(mcpBasePath)` from apps/mcp. */
  healthPath: string;
  /**
   * Key prefix inside each storage area: `dev/`, `prod/`, `pr-<n>/`. Every
   * stage has one, and none is a prefix of another, so a preview's scoped
   * grant (`<area>/pr-<n>/*`) can never reach a dev object.
   */
  storagePrefix: string;
  /** Appended to Fargate component names on pr-* (ECS names are per cluster). */
  componentSuffix: string;
  warm: number;
  spot: boolean;
  mcpScaling: { min: number; max: number };
  logRetention: "1 month" | "1 year";
  /** Listener rules on the ALB. Priorities: dev/prod 49000-49010, pr-<n> = 100 + n. */
  mcpRules: McpRule[];
}

const SHARED_RULE_PRIORITY = 49000;
const PR_RULE_PRIORITY_BASE = 100;
const PR_STAGE = /^pr-([1-9][0-9]*)$/;

export function stageInfo(stage: string): StageInfo {
  if (stage === "dev" || stage === "prod") {
    return {
      name: stage,
      kind: stage,
      ownsSharedResources: true,
      dbSchema: "public",
      mcpBasePath: "/mcp",
      healthPath: healthPathFor("/mcp"),
      // Never "": a dev key at the area root such as `uploads/pr-12/x` would
      // fall inside a preview's `uploads/pr-12/*` grant.
      storagePrefix: `${stage}/`,
      componentSuffix: "",
      warm: 1,
      spot: false,
      mcpScaling: { min: 1, max: 2 },
      logRetention: stage === "prod" ? "1 year" : "1 month",
      mcpRules: [
        { path: "/mcp", priority: SHARED_RULE_PRIORITY },
        { path: "/mcp/*", priority: SHARED_RULE_PRIORITY + 1 },
        { path: "/healthz", priority: SHARED_RULE_PRIORITY + 2 },
      ],
    };
  }

  const match = PR_STAGE.exec(stage);
  if (!match?.[1]) {
    throw new Error(
      `Unknown stage "${stage}". A2H deploys only the stages dev, prod and pr-<n> (n a PR number).`,
    );
  }
  const n = Number(match[1]);
  const priority = PR_RULE_PRIORITY_BASE + n;
  if (priority >= SHARED_RULE_PRIORITY) {
    throw new Error(
      `PR number ${n} would give listener priority ${priority}, which collides with the dev/prod range starting at ${SHARED_RULE_PRIORITY}.`,
    );
  }
  return {
    name: stage,
    kind: "pr",
    prNumber: n,
    ownsSharedResources: false,
    dbSchema: `pr_${n}`,
    mcpBasePath: `/pr-${n}/mcp`,
    healthPath: healthPathFor(`/pr-${n}/mcp`),
    storagePrefix: `pr-${n}/`,
    componentSuffix: `Pr${n}`,
    warm: 0,
    spot: true,
    mcpScaling: { min: 1, max: 1 },
    logRetention: "1 month",
    mcpRules: [{ path: `/pr-${n}/*`, priority }],
  };
}

/**
 * Hostnames when `domain` is set. prod: web `<domain>`, ALB `mcp.<domain>`.
 * dev: web `dev.<domain>`, ALB `mcp.dev.<domain>`. pr-<n>: web `pr-<n>.dev.<domain>`,
 * MCP through dev's ALB hostname.
 */
export function hostnames(stage: StageInfo, apex: string): { web: string; alb: string } {
  if (stage.kind === "prod") return { web: apex, alb: `mcp.${apex}` };
  const alb = `mcp.dev.${apex}`;
  if (stage.kind === "dev") return { web: `dev.${apex}`, alb };
  return { web: `${stage.name}.dev.${apex}`, alb };
}
