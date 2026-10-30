// What the mcp and worker containers receive as environment, by name.
// Pure: no SST globals, no I/O; unit-tested in infra/test/service-env.test.ts
// and read by tests/ci/infra-consistency.test.sh, which checks that every
// variable the apps read is one infra provides (m1-protocol-connector task 6.1).
// The SST wiring (Outputs, `ssm`, execution role) is containerConfig() in mcp.ts.
import { CLEARING_SHARE, FEE_RATE, hostnames, MCP_PORT, type StageInfo } from "./config.ts";
import { secretsEnvironment, STAGE_SECRET_KINDS, type SecretRef, type Service, type StageSecretKind } from "./stage-secrets.ts";

export type { Service } from "./stage-secrets.ts";

/**
 * The gate per stage kind (m1-hosted-connector design D3, Migration Plan):
 * prod never ships without it. Previews run with it off until the verify job
 * signs in through the mail sink:
 * TODO(m1-hosted-connector task 8.3): set `pr` to true once the preview
 * verify job obtains a token (A2H_TOKEN) before the contract run.
 */
export const AUTH_REQUIRED_BY_STAGE_KIND: Record<StageInfo["kind"], boolean> = { dev: true, pr: false, prod: true };

/**
 * Stage limits (proposal decision 5; design D5): configuration, not code
 * constants in the services. dev and prod use the owner's defaults (60 tool
 * calls a minute and 2,000 a day per principal, 4 held pings). Previews get
 * ten times the call limits: their verify job runs the contract and
 * adversarial suites as one principal, well over 60 calls a minute (measured
 * on a local stage), as dev's budget is raised for the same reason
 * (DEV_BUDGET_MULTIPLIER). They belong next to the development policy in
 * config.ts; kept here while infra PR #52 owns config.ts (move them with
 * task 8.1).
 */
export const STAGE_LIMITS: Record<StageInfo["kind"], { RATE_LIMIT_PER_MINUTE: number; RATE_LIMIT_PER_DAY: number; PING_MAX_CONCURRENT: number }> = {
  dev: { RATE_LIMIT_PER_MINUTE: 60, RATE_LIMIT_PER_DAY: 2000, PING_MAX_CONCURRENT: 4 },
  prod: { RATE_LIMIT_PER_MINUTE: 60, RATE_LIMIT_PER_DAY: 2000, PING_MAX_CONCURRENT: 4 },
  pr: { RATE_LIMIT_PER_MINUTE: 600, RATE_LIMIT_PER_DAY: 20000, PING_MAX_CONCURRENT: 4 },
};

/**
 * Plain (non-secret) environment of a service. Both services: the stage, the
 * fee rate and the clearing share (ADR 0002: `f` and `s` are configuration).
 * The worker also gets SIMULATOR_ENABLED (task 5.6: false on prod). The mcp
 * service also gets the resource server's switches and the limits
 * (m1-hosted-connector D3, D5); its URLs are in authEnvironment(). No
 * development principal: principals and their policies are database rows
 * (m1-hosted-connector D4), and both services refuse PRINCIPAL_*.
 */
export function plainEnvironment(service: Service, stage: StageInfo): Record<string, string> {
  const env: Record<string, string> = {
    PORT: String(MCP_PORT),
    STAGE: stage.name,
    MCP_BASE_PATH: stage.mcpBasePath,
    STORAGE_PREFIX: stage.storagePrefix,
    FEE_RATE: String(FEE_RATE),
    CLEARING_SHARE: String(CLEARING_SHARE),
  };
  if (service === "worker") env["SIMULATOR_ENABLED"] = String(stage.simulatorEnabled);
  if (service === "mcp") {
    env["AUTH_REQUIRED"] = String(AUTH_REQUIRED_BY_STAGE_KIND[stage.kind]);
    // dev and previews: QA reaches ping and the handshake without a token.
    env["PING_OPEN"] = String(stage.kind !== "prod");
    for (const [k, v] of Object.entries(STAGE_LIMITS[stage.kind])) env[k] = String(v);
  }
  return env;
}

/**
 * The web app's base URL, which hosts the stage's authorization server
 * (design D1): `https://<web host>` with a domain, else the distribution's
 * own URL (an SST output), without a trailing slash.
 */
export function webBaseUrl(stage: StageInfo, domain: string | undefined, distributionUrl: string): string {
  if (domain) return `https://${hostnames(stage, domain).web}`;
  return distributionUrl.replace(/\/$/, "");
}

/**
 * The mcp service's trust relationship (design D3): its resource URL
 * (`<ALB base URL><MCP_BASE_PATH>`, the only audience it accepts) and the
 * issuer and JWKS of the stage's authorization server.
 */
export function authEnvironment(stage: StageInfo, albBaseUrl: string, webUrl: string): Record<"MCP_RESOURCE_URL" | "AUTH_ISSUER" | "AUTH_JWKS_URL", string> {
  const issuer = `${webUrl}/api/auth`;
  return { MCP_RESOURCE_URL: `${albBaseUrl}${stage.mcpBasePath}`, AUTH_ISSUER: issuer, AUTH_JWKS_URL: `${issuer}/jwks` };
}

/**
 * Database connection settings (design D2, D3), the same for both services.
 * The password is never here: it is the ECS secret DB_PASSWORD.
 */
export function databaseEnvironment<T>(
  endpoint: { host: T; port: T; name: T },
  user: T,
  stage: StageInfo,
): Record<"DB_HOST" | "DB_PORT" | "DB_NAME" | "DB_USER" | "DB_SCHEMA" | "DB_JOBS_SCHEMA", T | string> {
  return {
    DB_HOST: endpoint.host,
    DB_PORT: endpoint.port,
    DB_NAME: endpoint.name,
    DB_USER: user,
    DB_SCHEMA: stage.dbSchema,
    DB_JOBS_SCHEMA: stage.jobsSchema,
  };
}

/** ECS secret of the database password (access.ts dbCredentials). */
export const DB_SECRET_ENV = ["DB_PASSWORD"] as const;
/** Storage environment (storage.ts storageArgs): every stage. */
export const STORAGE_ENV = ["UPLOADS_BUCKET"] as const;

/**
 * Every environment variable name a service receives from infra, sorted:
 * plain, the mcp service's URLs, database, storage and secrets. Placeholder values only; used by the
 * consistency test, never by the deployment.
 */
export function serviceEnvNames(service: Service, stage: StageInfo): string[] {
  const placeholder: SecretRef = {
    arn: "",
    versionId: "00000000-0000-0000-0000-000000000000",
  };
  const refs = Object.fromEntries(
    STAGE_SECRET_KINDS.map((kind) => [
      kind,
      { ...placeholder, arn: `arn:aws:secretsmanager:eu-west-3:000000000000:secret:a2h/${stage.name}/${kind}-AbC123` },
    ]),
  ) as Record<StageSecretKind, SecretRef>;
  const names = [
    ...Object.keys(plainEnvironment(service, stage)),
    ...(service === "mcp" ? Object.keys(authEnvironment(stage, "", "")) : []),
    ...Object.keys(databaseEnvironment({ host: "", port: "", name: "" }, "", stage)),
    ...DB_SECRET_ENV,
    ...STORAGE_ENV,
    ...Object.keys(secretsEnvironment(stage, service, refs)),
  ];
  return [...new Set(names)].sort();
}
