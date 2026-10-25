// Deployment adapter: the only place that knows how this deployment passes
// database credentials to the worker (infra/README.md, "Service environment"):
// DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_SCHEMA as plain environment,
// DB_PASSWORD injected by ECS from Secrets Manager, DB_CA_BUNDLE baked into
// the image by apps/worker/Dockerfile. It logs nothing.
import { readFileSync } from "node:fs";
import type { DbConfig } from "../src/db-config.ts";

type Env = Record<string, string | undefined>;

// pg-boss interpolates the schema name into its SQL: plain lower-case
// identifiers only (`public`, `pr_<n>`), at most 63 bytes.
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`worker configuration: ${name} is not set`);
  }
  return value;
}

export function dbConfigFromEnv(env: Env = process.env): DbConfig {
  const host = required(env, "DB_HOST");
  const database = required(env, "DB_NAME");
  const user = required(env, "DB_USER");
  const password = required(env, "DB_PASSWORD");
  const schema = required(env, "DB_SCHEMA");

  const portText = env["DB_PORT"] || "5432";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new Error("worker configuration: DB_PORT is not a port number");
  }
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error("worker configuration: DB_SCHEMA is not a plain lower-case identifier");
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

  return { connectionString, schema, ssl };
}
