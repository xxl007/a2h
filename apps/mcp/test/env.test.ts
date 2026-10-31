// Task 4.1: the deployment adapter (apps/mcp/infra/env.ts), the only code
// that knows how this deployment passes configuration to the mcp service
// (infra/service-env.ts): DB_* as plain environment, DB_PASSWORD and
// APPROVAL_KEY as ECS secrets, DB_CA_BUNDLE baked into the image, FEE_RATE
// and CLEARING_SHARE; since m1-hosted-connector (task 7.2, 7.3) the resource
// server's settings and the limits, and no development principal any more.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpConfigFromEnv } from "../infra/env.ts";

const PASSWORD = "s3cr3t-p@ss:w/rd#?%&=+ é";
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const APPROVAL_KEY = Buffer.from(KEY_BYTES).toString("base64");

const base: Record<string, string> = {
  STAGE: "pr-12",
  DB_HOST: "a2h-dev.cluster-xyz.eu-west-3.rds.amazonaws.com",
  DB_PORT: "5432",
  DB_NAME: "a2h",
  DB_USER: "pr_12",
  DB_PASSWORD: PASSWORD,
  DB_SCHEMA: "pr_12",
  DB_JOBS_SCHEMA: "pr_12_jobs",
  APPROVAL_KEY,
  MCP_BASE_PATH: "/pr-12/mcp",
  AUTH_REQUIRED: "true",
  AUTH_ISSUER: "https://pr-12.dev.a2h-protocol.org/api/auth",
  AUTH_JWKS_URL: "https://pr-12.dev.a2h-protocol.org/api/auth/jwks",
  MCP_RESOURCE_URL: "https://mcp.dev.a2h-protocol.org/pr-12/mcp",
  PING_OPEN: "true",
  PING_MAX_CONCURRENT: "4",
  RATE_LIMIT_PER_MINUTE: "60",
  RATE_LIMIT_PER_DAY: "2000",
  FEE_RATE: "0.2",
  CLEARING_SHARE: "0.5",
};

function silenceAndWatchConsole(t: TestContext): string[] {
  const seen: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    });
  }
  return seen;
}

test("builds the database connection, URL-encoding user and password, no TLS without DB_CA_BUNDLE", (t) => {
  const seen = silenceAndWatchConsole(t);
  const { db } = mcpConfigFromEnv({ ...base });
  const url = new URL(db.connectionString);
  assert.equal(url.hostname, base["DB_HOST"]);
  assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/a2h");
  assert.equal(decodeURIComponent(url.username), "pr_12");
  assert.equal(decodeURIComponent(url.password), PASSWORD);
  assert.equal(url.search, "");
  assert.equal(db.schema, "pr_12");
  assert.equal(db.ssl, false);
  assert.deepEqual(seen, [], "the adapter logs nothing");
});

test("DB_CA_BUNDLE pointing at a file: TLS that verifies the server certificate", (t) => {
  silenceAndWatchConsole(t);
  const dir = mkdtempSync(join(tmpdir(), "a2h-mcp-ca-"));
  const path = join(dir, "global-bundle.pem");
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  writeFileSync(path, pem);
  assert.deepEqual(mcpConfigFromEnv({ ...base, DB_CA_BUNDLE: path }).db.ssl, { ca: pem, rejectUnauthorized: true });
});

test("DB_CA_BUNDLE set but the file is missing: refuse to start rather than drop TLS", (t) => {
  const seen = silenceAndWatchConsole(t);
  assert.throws(
    () => mcpConfigFromEnv({ ...base, DB_CA_BUNDLE: "/nonexistent/global-bundle.pem" }),
    (error: Error) => {
      assert.match(error.message, /DB_CA_BUNDLE/);
      assert.ok(!error.message.includes(PASSWORD));
      return true;
    },
  );
  assert.deepEqual(seen, []);
});

test("the approval key is the 32 bytes of APPROVAL_KEY (base64), never shorter", (t) => {
  silenceAndWatchConsole(t);
  assert.deepEqual(mcpConfigFromEnv({ ...base }).approvalKey, KEY_BYTES);
  for (const bad of ["", "not base64!", Buffer.alloc(16).toString("base64")]) {
    assert.throws(
      () => mcpConfigFromEnv({ ...base, APPROVAL_KEY: bad }),
      (error: Error) => {
        assert.match(error.message, /APPROVAL_KEY/);
        if (bad) assert.ok(!error.message.includes(bad), "the key is never echoed");
        return true;
      },
    );
  }
});

test("fee rate, clearing share, resource-server settings and limits become values", (t) => {
  silenceAndWatchConsole(t);
  const c = mcpConfigFromEnv({ ...base });
  assert.equal(c.stage, "pr-12");
  assert.equal(c.feeRate, 0.2);
  assert.equal(c.clearingShare, 0.5);
  assert.deepEqual(c.auth, {
    required: true,
    issuer: "https://pr-12.dev.a2h-protocol.org/api/auth",
    jwksUrl: "https://pr-12.dev.a2h-protocol.org/api/auth/jwks",
    resourceUrl: "https://mcp.dev.a2h-protocol.org/pr-12/mcp",
    pingOpen: true,
  });
  assert.deepEqual(c.limits, { perMinute: 60, perDay: 2000 });
  assert.equal(c.pingMaxConcurrent, 4);
  assert.equal("principal" in c, false);
  assert.equal("policy" in c, false);
});

test("limits default to the stage defaults (60 a minute, 2000 a day, 4 held pings) when unset", (t) => {
  silenceAndWatchConsole(t);
  const env = { ...base };
  for (const n of ["RATE_LIMIT_PER_MINUTE", "RATE_LIMIT_PER_DAY", "PING_MAX_CONCURRENT"]) delete env[n];
  const c = mcpConfigFromEnv(env);
  assert.deepEqual(c.limits, { perMinute: 60, perDay: 2000 });
  assert.equal(c.pingMaxConcurrent, 4);
  assert.deepEqual(mcpConfigFromEnv({ ...base, RATE_LIMIT_PER_MINUTE: "5", RATE_LIMIT_PER_DAY: "7", PING_MAX_CONCURRENT: "1" }).limits, { perMinute: 5, perDay: 7 });
});

test("PRINCIPAL_* is refused: the principal comes from the token (m1-hosted-connector)", (t) => {
  silenceAndWatchConsole(t);
  for (const name of ["PRINCIPAL_ID", "PRINCIPAL_CURRENCY", "PRINCIPAL_MONTHLY_BUDGET_MINOR"]) {
    assert.throws(() => mcpConfigFromEnv({ ...base, [name]: "x" }), (error: Error) => {
      assert.match(error.message, new RegExp(name));
      assert.match(error.message, /m1-hosted-connector/);
      return true;
    });
  }
});

test("AUTH_REQUIRED=false is the rollback flag of dev and previews, refused on prod; PING_OPEN defaults to false", (t) => {
  silenceAndWatchConsole(t);
  assert.equal(mcpConfigFromEnv({ ...base, AUTH_REQUIRED: "false" }).auth.required, false);
  assert.throws(() => mcpConfigFromEnv({ ...base, STAGE: "prod", AUTH_REQUIRED: "false" }), /AUTH_REQUIRED/);
  const env = { ...base };
  delete env["PING_OPEN"];
  delete env["AUTH_REQUIRED"];
  const c = mcpConfigFromEnv(env);
  assert.equal(c.auth.pingOpen, false);
  assert.equal(c.auth.required, true);
});

test("the resource URL's path is the MCP path: otherwise the metadata would sit where no client looks", (t) => {
  silenceAndWatchConsole(t);
  assert.throws(() => mcpConfigFromEnv({ ...base, MCP_RESOURCE_URL: "https://mcp.dev.a2h-protocol.org/mcp" }), /MCP_RESOURCE_URL/);
});

test("missing or invalid variables fail by name, never echoing a secret", (t) => {
  const seen = silenceAndWatchConsole(t);
  const cases: Array<[Record<string, string>, RegExp]> = [];
  for (const name of ["STAGE", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SCHEMA", "APPROVAL_KEY", "FEE_RATE", "CLEARING_SHARE", "AUTH_ISSUER", "AUTH_JWKS_URL", "MCP_RESOURCE_URL"]) {
    const env = { ...base };
    delete env[name];
    cases.push([env, new RegExp(name)]);
  }
  cases.push([{ ...base, DB_PORT: "54x2" }, /DB_PORT/]);
  cases.push([{ ...base, DB_SCHEMA: "pr-12; drop" }, /DB_SCHEMA/]);
  cases.push([{ ...base, AUTH_REQUIRED: "yes" }, /AUTH_REQUIRED/]);
  cases.push([{ ...base, PING_OPEN: "1" }, /PING_OPEN/]);
  cases.push([{ ...base, AUTH_ISSUER: "not a url" }, /AUTH_ISSUER/]);
  cases.push([{ ...base, RATE_LIMIT_PER_MINUTE: "0" }, /RATE_LIMIT_PER_MINUTE/]);
  cases.push([{ ...base, PING_MAX_CONCURRENT: "-1" }, /PING_MAX_CONCURRENT/]);
  cases.push([{ ...base, FEE_RATE: "1" }, /FEE_RATE/]);
  cases.push([{ ...base, CLEARING_SHARE: "1.5" }, /CLEARING_SHARE/]);
  for (const [env, re] of cases) {
    assert.throws(
      () => mcpConfigFromEnv(env),
      (error: Error) => {
        assert.match(error.message, re);
        assert.ok(!error.message.includes(PASSWORD));
        assert.ok(!error.message.includes(APPROVAL_KEY));
        return true;
      },
    );
  }
  assert.deepEqual(seen, []);
});

test("startup: the service refuses to start when DB_CA_BUNDLE is set but unreadable, and logs no secret", () => {
  const entry = new URL("../src/index.ts", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [entry], {
    env: { PATH: process.env["PATH"] ?? "", ...base, PORT: "0", DB_CA_BUNDLE: "/nonexistent/global-bundle.pem" },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(run.status, 1, `exit status ${run.status}; stderr: ${run.stderr}`);
  const out = run.stdout + run.stderr;
  assert.match(out, /DB_CA_BUNDLE/);
  assert.ok(!out.includes(PASSWORD), "no password in the output");
  assert.ok(!out.includes(APPROVAL_KEY), "no approval key in the output");
  assert.doesNotMatch(out, /listening/);
});
