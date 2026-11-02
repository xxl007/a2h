// What the mcp and worker containers receive as environment, by name.
// Pure: no SST globals, no I/O; unit-tested in infra/test/service-env.test.ts
// and read by tests/ci/infra-consistency.test.sh, which checks that every
// variable the apps read is one infra provides (m1-protocol-connector task 6.1).
// The SST wiring (Outputs, `ssm`, execution role) is containerConfig() in mcp.ts.
import { CLEARING_SHARE, FEE_RATE, limitsFor, MCP_PORT, publicUrls, type StageInfo } from "./config.ts";
import { secretsEnvironment, STAGE_SECRET_KINDS, type SecretRef, type Service, type StageSecretKind } from "./stage-secrets.ts";

export type { Service } from "./stage-secrets.ts";

/**
 * The gate per stage kind (m1-hosted-connector design D3, D5, Migration
 * Plan): on everywhere. prod never ships without it. Previews ran with it off
 * until task 8.3 gave the verify jobs a token: they now sign in through the
 * mail sink and hand A2H_TOKEN to the suites (preview.yml, deploy.yml), so a
 * preview rehearses dev's and prod's gate. `false` on dev or a preview is the
 * Migration Plan rollback; the mcp env adapter refuses it on prod.
 */
export const AUTH_REQUIRED_BY_STAGE_KIND: Record<StageInfo["kind"], boolean> = { dev: true, pr: true, prod: true };

/**
 * PING_OPEN per stage kind (design D3, D5, D7: stage configuration). `true`
 * admits the handshake, tools/list and `ping` without a token, which QA used
 * on dev and previews while the verify jobs had no token. Since task 8.3 every
 * suite carries A2H_TOKEN (the idle-stream proof included: `ping` with a token
 * needs no scope), and the hosted-client matrix (task 9.3) needs the 401 on
 * the handshake for claude.ai, Claude Code and Inspector to start sign-in, so
 * it is off on every kind: the spec scenario "Handshake without a token" is
 * then verified live on a preview before the change reaches `main`, not only
 * on dev afterwards. Flip a kind to `true` only for a tokenless debugging
 * session, never prod (the health path and the metadata stay open regardless).
 */
export const PING_OPEN_BY_STAGE_KIND: Record<StageInfo["kind"], boolean> = { dev: false, pr: false, prod: false };

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
    env["PING_OPEN"] = String(PING_OPEN_BY_STAGE_KIND[stage.kind]);
    // Stage configuration (config.ts limitsFor, design D5); the edge limit is the WAF's.
    const limits = limitsFor(stage);
    env["RATE_LIMIT_PER_MINUTE"] = String(limits.perMinute);
    env["RATE_LIMIT_PER_DAY"] = String(limits.perDay);
    env["PING_MAX_CONCURRENT"] = String(limits.pingMaxConcurrent);
  }
  return env;
}

/**
 * The web app's base URL, which hosts the stage's authorization server
 * (design D1): `https://<web host>` with a domain, else the distribution's
 * own URL (an SST output), without a trailing slash.
 */
export function webBaseUrl(stage: StageInfo, domain: string | undefined, distributionUrl: string): string {
  if (domain) return publicUrls(stage, domain).web;
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
