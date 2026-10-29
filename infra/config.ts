// Stage model and constants for the A2H stacks. Pure: no SST globals, no I/O,
// so it is unit-tested with `node --test` (infra/test/config.test.ts).
// Contract: openspec/changes/m0-foundation/tasks.md §Step 4 and amendment 1.
// The health path comes from apps/mcp (pure, no SST), the one derivation.
import { createHash } from "node:crypto";
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

/** IAM's limit on role names. */
export const ROLE_NAME_MAX = 64;
const ROLE_NAME_HASH_LENGTH = 8;

/**
 * Physical name of every IAM role this app creates, set by the
 * `$transform(aws.iam.Role, …)` in sst.config.ts:
 * `a2h-<stage>-<readable>-<hash>`, at most 64 characters.
 *
 * SST's own `physicalName(64, …)` drops or truncates the `a2h-` prefix when
 * the logical name plus the stage is long (the Next.js revalidation
 * subscriber role comes out as `a-dev-…`, `prod-…`, `pr-12-…`), and the deploy
 * roles may only create `role/a2h-*`.
 *
 * - `<stage>` is kept whole (validated by `stageInfo`; `pr-48899` is the longest).
 * - `<readable>` is the logical name with non-alphanumerics removed, cut to fit.
 * - `<hash>` is the first 8 hex characters of SHA-256 over the full logical
 *   name: deterministic, and distinct for names that only differ past the
 *   cut, in removed characters or in case (IAM role names are unique
 *   case-insensitively).
 *
 * NEVER change this function after the first deploy without a migration
 * note: see infra/README.md, "IAM role names".
 */
export function roleName(stage: string, logicalName: string): string {
  const { name } = stageInfo(stage);
  const readable = logicalName.replace(/[^A-Za-z0-9]/g, "");
  if (readable === "") {
    throw new Error(`Role logical name "${logicalName}" has no alphanumeric character.`);
  }
  const hash = createHash("sha256").update(logicalName, "utf8").digest("hex").slice(0, ROLE_NAME_HASH_LENGTH);
  const prefix = `${APP_NAME}-${name}-`;
  const room = ROLE_NAME_MAX - prefix.length - 1 - hash.length;
  return `${prefix}${readable.slice(0, room)}-${hash}`;
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
 * "Idle stream survives" (mcp-transport spec) holds a response open with
 * nothing sent for 61 minutes = 3660 s, so 3600 would cut it: 4000, the AWS
 * maximum. The MCP server's keep-alive timeout (apps/mcp/src/http-timeouts.ts)
 * sits just above it.
 */
export const ALB_IDLE_TIMEOUT_SECONDS = 4000;

/**
 * OpenNext version that builds apps/web (`openNextVersion` of `sst.aws.Nextjs`,
 * which only changes the build command to `npx @opennextjs/aws@<v> build`).
 * SST 4.17.2 defaults to 3.9.14 for Next 15+, and 3.9.14 refuses Next 15.5.x
 * ("not supported by the Next.js team", needs
 * --dangerously-use-unsupported-next-version): preview deploy of PR #10 failed
 * on it. 4.1.12 (2026-10-21) is the first release that supports Next 15.5.x
 * without that flag (peer range `next >=15.5.28 <16 || >=16.4.1`); 4.0.0 has
 * no breaking change versus 3.10, and SST only reads `open-next.output.json`.
 * Vendor facts checked 2026-10-26. Remove once SST's default is >= this.
 */
export const OPEN_NEXT_VERSION = "4.1.12";

/** Container port of the MCP service (env PORT). */
export const MCP_PORT = 3000;

// Secrets: the per-stage signing and approval keys are created by the stage
// itself (stage-secrets.ts, design D4 amendment). Stripe (M4) and Better Auth
// secrets will be declared as `new sst.Secret(...)` and linked only to the
// services that use them.

/**
 * Owner-settable, through a reviewed PR. Rotation generation of the per-stage
 * keys on the long-lived stages (stage-secrets.ts). Bumping a number and
 * deploying creates a new key and a new version of `a2h/<stage>/<kind>`; the
 * services roll onto it. Never lower a number. Previews always use 1.
 * Procedure: docs/runbooks/aws-bootstrap.md §14.
 */
export const STAGE_KEY_GENERATIONS = {
  dev: { signing: 1, approval: 1 },
  prod: { signing: 1, approval: 1 },
} as const satisfies Record<"dev" | "prod", { signing: number; approval: number }>;

/**
 * Platform fee rate `f` (ADR 0002 §4): gross = net / (1 - f). OPEN: the value
 * is fixed by the ADR before M4; until then this is a development value. No
 * money moves in M1; the services only compute and display amounts with it.
 */
export const FEE_RATE = 0.2;
/**
 * Clearing share `s` (ADR 0002 §3): clearing = reserve + s x (bid - reserve).
 * OPEN like FEE_RATE; development value.
 */
export const CLEARING_SHARE = 0.5;

/**
 * The one principal of a stage while no authorization exists (design D7):
 * not real-name verified, so the `authorisation` intent is refused for it.
 * Shape: PrincipalSchema of packages/protocol (checked in config.test.ts).
 */
export function developmentPrincipal(stage: StageInfo) {
  return {
    principal_id: `dev-principal-${stage.name}`,
    identity_mode: "verified_organisation" as const,
    verified: true,
  };
}

/**
 * The development principal's contact policy and the fee rate (design D7),
 * in the field names of ValidationPolicySchema (packages/protocol), which
 * config.test.ts parses it with. Amounts in euro cents. The base for every
 * stage; `developmentPolicy(stage)` is what a stage receives.
 */
export const DEVELOPMENT_POLICY = {
  fee_rate: FEE_RATE,
  currency: "EUR",
  monthly_budget_minor: 50_000,
  per_request_cap_minor: 6_000,
  /** null: every request asks the principal first (M1 always elicits). */
  ask_first_above_minor: null as number | null,
  daily_request_limit: 50,
  throttled_daily_limit: 5,
};

/**
 * `dev` runs the deploy verification (contract, e2e) on every push to main,
 * and each run commits about €54 of the principal's budget: at the base budget
 * about nine pushes in a month would exhaust it and block verification. Dev's
 * monthly budget is therefore ten times the base; prod and previews keep it.
 */
export const DEV_BUDGET_MULTIPLIER = 10;

/** The development principal's policy on a stage (design D7). */
export function developmentPolicy(stage: StageInfo): typeof DEVELOPMENT_POLICY {
  return stage.kind === "dev"
    ? { ...DEVELOPMENT_POLICY, monthly_budget_minor: DEVELOPMENT_POLICY.monthly_budget_minor * DEV_BUDGET_MULTIPLIER }
    : { ...DEVELOPMENT_POLICY };
}

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
  /** pg-boss schema (design D3): `pgboss` on dev/prod, `pr_<n>_jobs` on previews. */
  jobsSchema: string;
  /** Simulated participants run on dev and previews, never on prod (task 5.6). */
  simulatorEnabled: boolean;
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
      jobsSchema: "pgboss",
      simulatorEnabled: stage !== "prod",
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
    jobsSchema: `pr_${n}_jobs`,
    simulatorEnabled: true,
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
