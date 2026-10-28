// Deployment adapter: the only place that knows how this deployment passes
// configuration to the worker (infra/README.md, "Service environment";
// infra/service-env.ts lists every name):
// - database: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_SCHEMA, DB_JOBS_SCHEMA as
//   plain environment, DB_PASSWORD injected by ECS from Secrets Manager,
//   DB_CA_BUNDLE baked into the image by apps/worker/Dockerfile;
// - STAGE, SIMULATOR_ENABLED, the development principal and its policy
//   (PRINCIPAL_*), FEE_RATE and CLEARING_SHARE as plain environment;
// - SIGNING_KEY_ID, SIGNING_PRIVATE_KEY (base64 PKCS#8 DER) and
//   SIGNING_PUBLIC_KEY (base64 raw) from the secret a2h/<stage>/signing.
// It logs nothing and never puts a value it read into an error message.
import { readFileSync } from "node:fs";
import {
  CurrencySchema,
  OpaqueIdSchema,
  PrincipalSchema,
  PUBLIC_KEY_PATTERN,
  ValidationPolicySchema,
  type Principal,
  type ValidationPolicy,
} from "@a2h/protocol";
import type { SigningKeyMaterial, WorkerConfig } from "../src/config.ts";
import type { DbConfig } from "../src/db-config.ts";

type Env = Record<string, string | undefined>;

// pg-boss interpolates the schema name into its SQL: plain lower-case
// identifiers only (`public`, `pr_<n>`, `pgboss`, `pr_<n>_jobs`), at most 63 bytes.
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const DECIMAL_RATE = /^(0|1)(\.[0-9]+)?$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`worker configuration: ${name} is not set`);
  }
  return value;
}

function invalid(name: string, what: string): Error {
  return new Error(`worker configuration: ${name} is not ${what}`);
}

function identifier(env: Env, name: string): string {
  const value = required(env, name);
  if (!SCHEMA_NAME.test(value)) throw invalid(name, "a plain lower-case identifier");
  return value;
}

function bool(env: Env, name: string): boolean {
  const value = required(env, name);
  if (value !== "true" && value !== "false") throw invalid(name, "true or false");
  return value === "true";
}

function integer(env: Env, name: string): number {
  const value = required(env, name);
  if (!DECIMAL_INTEGER.test(value) || !Number.isSafeInteger(Number(value))) throw invalid(name, "a non-negative integer");
  return Number(value);
}

function rate(env: Env, name: string, { allowOne }: { allowOne: boolean }): number {
  const value = required(env, name);
  const n = Number(value);
  if (!DECIMAL_RATE.test(value) || !(n >= 0 && (allowOne ? n <= 1 : n < 1))) {
    throw invalid(name, allowOne ? "a rate in [0, 1]" : "a rate in [0, 1)");
  }
  return n;
}

function bytes(env: Env, name: string): Uint8Array {
  const value = required(env, name);
  if (!BASE64.test(value) || value.length % 4 !== 0) throw invalid(name, "base64");
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function dbConfigFromEnv(env: Env = process.env): DbConfig {
  const host = required(env, "DB_HOST");
  const database = required(env, "DB_NAME");
  const user = required(env, "DB_USER");
  const password = required(env, "DB_PASSWORD");
  const schema = identifier(env, "DB_SCHEMA");
  const jobsSchema = identifier(env, "DB_JOBS_SCHEMA");
  if (jobsSchema === schema) throw invalid("DB_JOBS_SCHEMA", "a schema of its own (it equals DB_SCHEMA)");

  const portText = env["DB_PORT"] || "5432";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new Error("worker configuration: DB_PORT is not a port number");
  }

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
      throw new Error(`worker configuration: DB_CA_BUNDLE file ${caPath} cannot be read`);
    }
    ssl = { ca, rejectUnauthorized: true };
  }

  const connectionString =
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${encodeURIComponent(database)}`;

  return { connectionString, schema, jobsSchema, ssl };
}

function principalFromEnv(env: Env): Principal {
  const principal = {
    principal_id: required(env, "PRINCIPAL_ID"),
    identity_mode: required(env, "PRINCIPAL_IDENTITY_MODE"),
    verified: bool(env, "PRINCIPAL_VERIFIED"),
  };
  if (!OpaqueIdSchema.safeParse(principal.principal_id).success) throw invalid("PRINCIPAL_ID", "an opaque identifier");
  const parsed = PrincipalSchema.safeParse(principal);
  if (!parsed.success) throw invalid("PRINCIPAL_IDENTITY_MODE", "an identity mode");
  return parsed.data;
}

function policyFromEnv(env: Env): ValidationPolicy {
  const currency = required(env, "PRINCIPAL_CURRENCY");
  if (!CurrencySchema.safeParse(currency).success) throw invalid("PRINCIPAL_CURRENCY", "an ISO 4217 code");
  const askFirst = required(env, "PRINCIPAL_ASK_FIRST_ABOVE_MINOR");
  const policy = {
    fee_rate: rate(env, "FEE_RATE", { allowOne: false }),
    currency,
    monthly_budget_minor: integer(env, "PRINCIPAL_MONTHLY_BUDGET_MINOR"),
    per_request_cap_minor: integer(env, "PRINCIPAL_PER_REQUEST_CAP_MINOR"),
    ask_first_above_minor: askFirst === "none" ? null : integer(env, "PRINCIPAL_ASK_FIRST_ABOVE_MINOR"),
    daily_request_limit: integer(env, "PRINCIPAL_DAILY_REQUEST_LIMIT"),
    throttled_daily_limit: integer(env, "PRINCIPAL_THROTTLED_DAILY_LIMIT"),
  };
  // Every field was checked above; this is the protocol's own word on the shape.
  if (!ValidationPolicySchema.safeParse(policy).success) throw invalid("PRINCIPAL_*", "a valid contact policy");
  return policy;
}

function signingFromEnv(env: Env): SigningKeyMaterial {
  const key_id = required(env, "SIGNING_KEY_ID");
  if (!OpaqueIdSchema.safeParse(key_id).success) throw invalid("SIGNING_KEY_ID", "an opaque identifier");
  const private_key_pkcs8 = bytes(env, "SIGNING_PRIVATE_KEY");
  const public_key = required(env, "SIGNING_PUBLIC_KEY");
  if (!PUBLIC_KEY_PATTERN.test(public_key)) throw invalid("SIGNING_PUBLIC_KEY", "base64 of a raw 32-byte Ed25519 key");
  return { key_id, private_key_pkcs8, public_key };
}

export function workerConfigFromEnv(env: Env = process.env): WorkerConfig {
  const stage = required(env, "STAGE");
  // The simulator never runs on prod (spec participant-simulation "Nothing on
  // production"), whatever SIMULATOR_ENABLED says.
  const simulatorEnabled = bool(env, "SIMULATOR_ENABLED") && stage !== "prod";
  return {
    stage,
    db: dbConfigFromEnv(env),
    simulatorEnabled,
    principal: principalFromEnv(env),
    policy: policyFromEnv(env),
    clearingShare: rate(env, "CLEARING_SHARE", { allowOne: true }),
    signing: signingFromEnv(env),
  };
}
