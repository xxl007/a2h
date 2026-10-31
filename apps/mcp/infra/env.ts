// Deployment adapter: the only place that knows how this deployment passes
// configuration to the mcp service (infra/service-env.ts): DB_HOST, DB_PORT,
// DB_NAME, DB_USER, DB_SCHEMA, MCP_BASE_PATH, FEE_RATE, CLEARING_SHARE, the
// resource server's AUTH_REQUIRED, AUTH_ISSUER, AUTH_JWKS_URL,
// MCP_RESOURCE_URL, PING_OPEN, and the limits RATE_LIMIT_PER_MINUTE,
// RATE_LIMIT_PER_DAY, PING_MAX_CONCURRENT as plain environment; DB_PASSWORD and
// APPROVAL_KEY (base64 of 32 bytes, from `a2h/<stage>/approval`) injected by
// ECS from Secrets Manager; DB_CA_BUNDLE baked into the image by
// apps/mcp/Dockerfile. Mirrors apps/worker/infra/env.ts. It logs nothing, and
// no error message carries a value.
import { readFileSync } from "node:fs";
import type { DbConfig, McpConfig } from "../src/config.ts";

type Env = Record<string, string | undefined>;

// The schema name is interpolated into the connection's search_path: plain
// lower-case identifiers only (`public`, `pr_<n>`), at most 63 bytes.
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const APPROVAL_KEY_MIN_BYTES = 32;

/** Stage defaults of the limits (m1-hosted-connector proposal decision 5), used when a variable is unset. */
export const DEFAULT_LIMITS = { RATE_LIMIT_PER_MINUTE: 60, RATE_LIMIT_PER_DAY: 2000, PING_MAX_CONCURRENT: 4 } as const;

function fail(message: string): never {
  throw new Error(`mcp configuration: ${message}`);
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") fail(`${name} is not set`);
  return value;
}

function integer(env: Env, name: string): number {
  const text = required(env, name);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) fail(`${name} is not a non-negative integer`);
  return Number(text);
}

function rate(env: Env, name: string): number {
  const text = required(env, name);
  if (!/^\d+(\.\d+)?$/.test(text)) fail(`${name} is not a decimal number`);
  return Number(text);
}

export function dbConfigFromEnv(env: Env = process.env): DbConfig {
  const host = required(env, "DB_HOST");
  const database = required(env, "DB_NAME");
  const user = required(env, "DB_USER");
  const password = required(env, "DB_PASSWORD");
  const schema = required(env, "DB_SCHEMA");

  const portText = env["DB_PORT"] || "5432";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) fail("DB_PORT is not a port number");
  if (!SCHEMA_NAME.test(schema)) fail("DB_SCHEMA is not a plain lower-case identifier");

  // TLS to Aurora verifies the server certificate against the RDS CA bundle
  // baked into the image. If DB_CA_BUNDLE is set the file must be there:
  // refusing to start beats silently connecting without TLS.
  let ssl: DbConfig["ssl"] = false;
  const caPath = env["DB_CA_BUNDLE"];
  if (caPath) {
    let ca: string;
    try {
      ca = readFileSync(caPath, "utf8");
    } catch {
      fail(`DB_CA_BUNDLE file ${caPath} cannot be read`);
    }
    ssl = { ca, rejectUnauthorized: true };
  }

  const connectionString =
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${encodeURIComponent(database)}`;
  return { connectionString, schema, ssl };
}

function approvalKeyFromEnv(env: Env): Uint8Array {
  const text = required(env, "APPROVAL_KEY");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) fail("APPROVAL_KEY is not base64");
  const key = new Uint8Array(Buffer.from(text, "base64"));
  if (key.length < APPROVAL_KEY_MIN_BYTES) fail(`APPROVAL_KEY is shorter than ${APPROVAL_KEY_MIN_BYTES} bytes`);
  return key;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (value !== "true" && value !== "false") fail(`${name} is not true or false`);
  return value === "true";
}

function positive(env: Env, name: keyof typeof DEFAULT_LIMITS): number {
  if (env[name] === undefined || env[name] === "") return DEFAULT_LIMITS[name];
  const n = integer(env, name);
  if (n < 1) fail(`${name} is not a positive integer`);
  return n;
}

function url(env: Env, name: string): string {
  const text = required(env, name);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail(`${name} is not a URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") fail(`${name} is not an http(s) URL`);
  return text.replace(/\/$/, "");
}

export function mcpConfigFromEnv(env: Env = process.env): McpConfig {
  // The development principal left with m1-hosted-connector: a stale
  // variable means a stale deployment, so refuse it rather than ignore it.
  const stale = Object.keys(env).find((k) => k.startsWith("PRINCIPAL_"));
  if (stale) fail(`${stale} is set, but the development principal was removed by m1-hosted-connector (the principal is the token's account); remove PRINCIPAL_* from the environment`);

  const stage = required(env, "STAGE");
  const db = dbConfigFromEnv(env);
  const approvalKey = approvalKeyFromEnv(env);
  const mcpBasePath = env["MCP_BASE_PATH"] || "/mcp";

  const feeRate = rate(env, "FEE_RATE");
  if (feeRate >= 1) fail("FEE_RATE is not below 1");
  const clearingShare = rate(env, "CLEARING_SHARE");
  if (clearingShare > 1) fail("CLEARING_SHARE is not between 0 and 1");

  const authRequired = flag(env, "AUTH_REQUIRED", true);
  // Migration Plan rollback: dev and previews only; prod never ships without the gate.
  if (!authRequired && stage === "prod") fail("AUTH_REQUIRED=false is refused on prod");
  const resourceUrl = url(env, "MCP_RESOURCE_URL");
  if (new URL(resourceUrl).pathname !== mcpBasePath) fail("MCP_RESOURCE_URL does not end in MCP_BASE_PATH");
  const auth = {
    required: authRequired,
    issuer: url(env, "AUTH_ISSUER"),
    jwksUrl: url(env, "AUTH_JWKS_URL"),
    resourceUrl,
    pingOpen: flag(env, "PING_OPEN", false),
  };

  return {
    stage,
    db,
    approvalKey,
    mcpBasePath,
    feeRate,
    clearingShare,
    auth,
    limits: { perMinute: positive(env, "RATE_LIMIT_PER_MINUTE"), perDay: positive(env, "RATE_LIMIT_PER_DAY") },
    pingMaxConcurrent: positive(env, "PING_MAX_CONCURRENT"),
  };
}
