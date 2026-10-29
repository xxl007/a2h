// What the mcp service needs to run the A2H tools. Built by the deployment
// adapter (infra/env.ts); business code depends on these shapes only, never
// on how a deployment passes them.
import type { Principal, ValidationPolicy } from "@a2h/protocol";

/** What the service needs to reach Postgres (mirrors apps/worker/src/db-config.ts). */
export interface DbConfig {
  /** `postgres://user:password@host:port/db`. Contains the password: never log it. */
  connectionString: string;
  /** Schema that holds this stage's tables (`public` or `pr_<n>`). */
  schema: string;
  /** `false`: no TLS (local tests). Otherwise TLS that verifies the server. */
  ssl: false | { ca: string; rejectUnauthorized: true };
}

export interface McpConfig {
  stage: string;
  db: DbConfig;
  /** HMAC key of the approval state codec (design D1): 32 bytes or more. Never log it. */
  approvalKey: Uint8Array;
  /** The stage's development principal (design D7): the accountable principal of every request. */
  principal: Principal;
  /** Its contact policy and the platform fee rate (ADR 0002: configuration, not code). */
  policy: ValidationPolicy;
  /** Clearing share `s` (ADR 0002 §3), configuration. */
  clearingShare: number;
}
