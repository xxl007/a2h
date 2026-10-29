// What the mcp and worker containers receive as environment, by name.
// Pure: no SST globals, no I/O; unit-tested in infra/test/service-env.test.ts
// and read by tests/ci/infra-consistency.test.sh, which checks that every
// variable the apps read is one infra provides (m1-protocol-connector task 6.1).
// The SST wiring (Outputs, `ssm`, execution role) is containerConfig() in mcp.ts.
import {
  CLEARING_SHARE,
  developmentPolicy,
  developmentPrincipal,
  FEE_RATE,
  MCP_PORT,
  type StageInfo,
} from "./config.ts";
import { secretsEnvironment, STAGE_SECRET_KINDS, type SecretRef, type Service, type StageSecretKind } from "./stage-secrets.ts";

export type { Service } from "./stage-secrets.ts";

/**
 * Plain (non-secret) environment of a service. Both services: the stage, the
 * development principal and its contact policy, the fee rate and the clearing
 * share (design D7; ADR 0002: `f` and `s` are configuration). The worker also
 * gets SIMULATOR_ENABLED (task 5.6: false on prod).
 *
 * PRINCIPAL_ASK_FIRST_ABOVE_MINOR is a decimal integer, or `none` for
 * ValidationPolicy's `null` (every request asks first).
 */
export function plainEnvironment(service: Service, stage: StageInfo): Record<string, string> {
  const principal = developmentPrincipal(stage);
  const p = developmentPolicy(stage);
  const env: Record<string, string> = {
    PORT: String(MCP_PORT),
    STAGE: stage.name,
    MCP_BASE_PATH: stage.mcpBasePath,
    STORAGE_PREFIX: stage.storagePrefix,
    PRINCIPAL_ID: principal.principal_id,
    PRINCIPAL_IDENTITY_MODE: principal.identity_mode,
    PRINCIPAL_VERIFIED: String(principal.verified),
    PRINCIPAL_CURRENCY: p.currency,
    PRINCIPAL_MONTHLY_BUDGET_MINOR: String(p.monthly_budget_minor),
    PRINCIPAL_PER_REQUEST_CAP_MINOR: String(p.per_request_cap_minor),
    PRINCIPAL_ASK_FIRST_ABOVE_MINOR: p.ask_first_above_minor === null ? "none" : String(p.ask_first_above_minor),
    PRINCIPAL_DAILY_REQUEST_LIMIT: String(p.daily_request_limit),
    PRINCIPAL_THROTTLED_DAILY_LIMIT: String(p.throttled_daily_limit),
    FEE_RATE: String(FEE_RATE),
    CLEARING_SHARE: String(CLEARING_SHARE),
  };
  if (service === "worker") env["SIMULATOR_ENABLED"] = String(stage.simulatorEnabled);
  return env;
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
 * plain, database, storage and secrets. Placeholder values only; used by the
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
    ...Object.keys(databaseEnvironment({ host: "", port: "", name: "" }, "", stage)),
    ...DB_SECRET_ENV,
    ...STORAGE_ENV,
    ...Object.keys(secretsEnvironment(stage, service, refs)),
  ];
  return [...new Set(names)].sort();
}
