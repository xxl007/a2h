// What the worker needs to reach Postgres. Built by the deployment adapter
// (infra/env.ts); business code depends on this shape only, never on how a
// deployment passes credentials.

export interface DbConfig {
  /** `postgres://user:password@host:port/db`. Contains the password: never log it. */
  connectionString: string;
  /** Schema that holds this stage's tables (`public` or `pr_<n>`). */
  schema: string;
  /** Schema that holds pg-boss's tables (`pgboss`, or `pr_<n>_jobs` on previews; design D3). */
  jobsSchema: string;
  /** `false`: no TLS (local tests). Otherwise TLS that verifies the server. */
  ssl: false | { ca: string; rejectUnauthorized: true };
}
