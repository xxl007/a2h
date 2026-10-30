// What the web Lambda receives (m1-hosted-connector group 5; design D1, D2,
// D6, D7), as names and values. Pure: no SST globals, no I/O; unit-tested in
// infra/test/web-env.test.ts and read by apps/web's configuration test. The
// SST wiring is createWeb() in web.ts.
import { prDbSecretName } from "./access.ts";
import { developmentPolicy, hostnames, REGION, type StageInfo } from "./config.ts";

/** SSM SecureString holding the allow-list (D7); created by the dev deploy (PR #57); dev and previews read it. */
export const ALLOWLIST_PARAMETERS = {
  shared: "/a2h/shared/principal-allowlist",
  prod: "/a2h/prod/principal-allowlist",
} as const;

export function allowlistParameter(stage: StageInfo): string {
  return stage.kind === "prod" ? ALLOWLIST_PARAMETERS.prod : ALLOWLIST_PARAMETERS.shared;
}

/** Database name on every cluster (database.ts). */
export const DB_NAME = "a2h";

/** `https://<web host>/api/auth`, or undefined while the stage has no domain (no HTTPS MCP URL either). */
export function authIssuer(stage: StageInfo, domain: string | undefined): string | undefined {
  return domain ? `https://${hostnames(stage, domain).web}/api/auth` : undefined;
}

export interface WebEnvInputs {
  domain?: string | undefined;
  /** The `email-sender` shared value: a domain, an address, or "none". */
  emailSender?: string | undefined;
}

function fromAddress(sender: string | undefined): string | undefined {
  if (!sender || sender === "none") return undefined;
  return sender.includes("@") ? `A2H <${sender}>` : `A2H <sign-in@${sender}>`;
}

/** Plain (non-secret) environment of the web Lambda, besides STAGE, STORAGE_PREFIX, MCP_URL and storage. */
export function webPlainEnvironment(stage: StageInfo, inputs: WebEnvInputs): Record<string, string> {
  const p = developmentPolicy(stage);
  const env: Record<string, string> = {
    DB_NAME,
    DB_SCHEMA: stage.dbSchema,
    ALLOWLIST_PARAMETER: allowlistParameter(stage),
    PRINCIPAL_CURRENCY: p.currency,
    PRINCIPAL_MONTHLY_BUDGET_MINOR: String(p.monthly_budget_minor),
    PRINCIPAL_PER_REQUEST_CAP_MINOR: String(p.per_request_cap_minor),
    PRINCIPAL_ASK_FIRST_ABOVE_MINOR: p.ask_first_above_minor === null ? "none" : String(p.ask_first_above_minor),
    PRINCIPAL_DAILY_REQUEST_LIMIT: String(p.daily_request_limit),
    PRINCIPAL_THROTTLED_DAILY_LIMIT: String(p.throttled_daily_limit),
  };
  const issuer = authIssuer(stage, inputs.domain);
  if (issuer) env["AUTH_ISSUER"] = issuer;
  const from = fromAddress(inputs.emailSender);
  if (from) env["EMAIL_FROM"] = from;
  return env;
}

const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

/** `<secretArn>:<jsonKey>::[version]` (access.ts secretValueFrom) -> the secret ARN. */
export function secretArnFromValueFrom(valueFrom: string): string {
  const arn = valueFrom.replace(/:[A-Za-z0-9_]+::[A-Za-z0-9-]*$/, "");
  if (!SECRET_ARN.test(arn)) throw new Error(`Not a Secrets Manager valueFrom: "${valueFrom}".`);
  return arn;
}

export const RDS_DATA_ACTIONS = [
  "rds-data:BatchExecuteStatement",
  "rds-data:BeginTransaction",
  "rds-data:CommitTransaction",
  "rds-data:ExecuteStatement",
  "rds-data:RollbackTransaction",
] as const;

export interface PermissionStatement {
  actions: string[];
  resources: string[];
}

/**
 * The web Lambda's grants for the Data API (D2): the cluster, the stage's own
 * database secret (previews: `a2h/pr-<n>/db`, never the master secret), and
 * the allow-list parameter (D7).
 */
export function webDatabasePermissions(
  stage: StageInfo,
  input: { clusterArn: string; secretArn: string; accountId: string },
): PermissionStatement[] {
  if (stage.kind === "pr" && !input.secretArn.includes(`:secret:${prDbSecretName(stage)}-`)) {
    throw new Error(`Stage "${stage.name}" must read its database through ${prDbSecretName(stage)}, got "${input.secretArn}".`);
  }
  return [
    { actions: [...RDS_DATA_ACTIONS], resources: [input.clusterArn] },
    { actions: ["secretsmanager:GetSecretValue"], resources: [input.secretArn] },
    { actions: ["ssm:GetParameter"], resources: [`arn:aws:ssm:${REGION}:${input.accountId}:parameter${allowlistParameter(stage)}`] },
  ];
}
