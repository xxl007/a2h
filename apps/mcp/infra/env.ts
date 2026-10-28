// Deployment adapter: the only place that knows how this deployment passes
// configuration to the mcp service (infra/service-env.ts): DB_HOST, DB_PORT,
// DB_NAME, DB_USER, DB_SCHEMA, the development principal and its policy,
// FEE_RATE and CLEARING_SHARE as plain environment; DB_PASSWORD and
// APPROVAL_KEY (base64 of 32 bytes, from `a2h/<stage>/approval`) injected by
// ECS from Secrets Manager; DB_CA_BUNDLE baked into the image by
// apps/mcp/Dockerfile. Mirrors apps/worker/infra/env.ts. It logs nothing, and
// no error message carries a value.
import { readFileSync } from "node:fs";
import { PrincipalSchema, ValidationPolicySchema } from "@a2h/protocol";
import type { DbConfig, McpConfig } from "../src/config.ts";

type Env = Record<string, string | undefined>;

// The schema name is interpolated into the connection's search_path: plain
// lower-case identifiers only (`public`, `pr_<n>`), at most 63 bytes.
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const APPROVAL_KEY_MIN_BYTES = 32;

/** ValidationPolicy field -> the variable it comes from, for error messages. */
const POLICY_ENV: Record<string, string> = {
  fee_rate: "FEE_RATE",
  currency: "PRINCIPAL_CURRENCY",
  monthly_budget_minor: "PRINCIPAL_MONTHLY_BUDGET_MINOR",
  per_request_cap_minor: "PRINCIPAL_PER_REQUEST_CAP_MINOR",
  ask_first_above_minor: "PRINCIPAL_ASK_FIRST_ABOVE_MINOR",
  daily_request_limit: "PRINCIPAL_DAILY_REQUEST_LIMIT",
  throttled_daily_limit: "PRINCIPAL_THROTTLED_DAILY_LIMIT",
};

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

export function mcpConfigFromEnv(env: Env = process.env): McpConfig {
  const stage = required(env, "STAGE");
  const db = dbConfigFromEnv(env);
  const approvalKey = approvalKeyFromEnv(env);

  const verifiedText = required(env, "PRINCIPAL_VERIFIED");
  if (verifiedText !== "true" && verifiedText !== "false") fail("PRINCIPAL_VERIFIED is not true or false");
  const principal = PrincipalSchema.safeParse({
    principal_id: required(env, "PRINCIPAL_ID"),
    identity_mode: required(env, "PRINCIPAL_IDENTITY_MODE"),
    verified: verifiedText === "true",
  });
  if (!principal.success) {
    const field = String(principal.error.issues[0]?.path[0] ?? "");
    fail(`${field === "identity_mode" ? "PRINCIPAL_IDENTITY_MODE" : "PRINCIPAL_ID"} is not valid`);
  }

  const askFirst = required(env, "PRINCIPAL_ASK_FIRST_ABOVE_MINOR");
  const policy = ValidationPolicySchema.safeParse({
    fee_rate: rate(env, "FEE_RATE"),
    currency: required(env, "PRINCIPAL_CURRENCY"),
    monthly_budget_minor: integer(env, "PRINCIPAL_MONTHLY_BUDGET_MINOR"),
    per_request_cap_minor: integer(env, "PRINCIPAL_PER_REQUEST_CAP_MINOR"),
    ask_first_above_minor: askFirst === "none" ? null : integer(env, "PRINCIPAL_ASK_FIRST_ABOVE_MINOR"),
    daily_request_limit: integer(env, "PRINCIPAL_DAILY_REQUEST_LIMIT"),
    throttled_daily_limit: integer(env, "PRINCIPAL_THROTTLED_DAILY_LIMIT"),
  });
  if (!policy.success) {
    const field = String(policy.error.issues[0]?.path[0] ?? "");
    fail(`${POLICY_ENV[field] ?? "the principal policy"} is not valid`);
  }

  const clearingShare = rate(env, "CLEARING_SHARE");
  if (clearingShare > 1) fail("CLEARING_SHARE is not between 0 and 1");

  return { stage, db, approvalKey, principal: principal.data, policy: policy.data, clearingShare };
}
