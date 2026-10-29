// Task 4.1: the deployment adapter (apps/mcp/infra/env.ts), the only code
// that knows how this deployment passes configuration to the mcp service
// (infra/service-env.ts): DB_* as plain environment, DB_PASSWORD and
// APPROVAL_KEY as ECS secrets, DB_CA_BUNDLE baked into the image, the
// development principal and its policy, FEE_RATE and CLEARING_SHARE.
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
  PRINCIPAL_ID: "dev-principal-pr-12",
  PRINCIPAL_IDENTITY_MODE: "verified_organisation",
  PRINCIPAL_VERIFIED: "true",
  PRINCIPAL_CURRENCY: "EUR",
  PRINCIPAL_MONTHLY_BUDGET_MINOR: "50000",
  PRINCIPAL_PER_REQUEST_CAP_MINOR: "6000",
  PRINCIPAL_ASK_FIRST_ABOVE_MINOR: "none",
  PRINCIPAL_DAILY_REQUEST_LIMIT: "50",
  PRINCIPAL_THROTTLED_DAILY_LIMIT: "5",
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

test("the development principal and its policy become protocol values (design D7)", (t) => {
  silenceAndWatchConsole(t);
  const c = mcpConfigFromEnv({ ...base });
  assert.equal(c.stage, "pr-12");
  assert.deepEqual(c.principal, { principal_id: "dev-principal-pr-12", identity_mode: "verified_organisation", verified: true });
  assert.deepEqual(c.policy, {
    fee_rate: 0.2,
    currency: "EUR",
    monthly_budget_minor: 50000,
    per_request_cap_minor: 6000,
    ask_first_above_minor: null,
    daily_request_limit: 50,
    throttled_daily_limit: 5,
  });
  assert.equal(c.clearingShare, 0.5);
  assert.equal(mcpConfigFromEnv({ ...base, PRINCIPAL_ASK_FIRST_ABOVE_MINOR: "1000" }).policy.ask_first_above_minor, 1000);
});

test("missing or invalid variables fail by name, never echoing a secret", (t) => {
  const seen = silenceAndWatchConsole(t);
  const cases: Array<[Record<string, string>, RegExp]> = [];
  for (const name of ["STAGE", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SCHEMA", "APPROVAL_KEY", "PRINCIPAL_ID", "FEE_RATE", "CLEARING_SHARE"]) {
    const env = { ...base };
    delete env[name];
    cases.push([env, new RegExp(name)]);
  }
  cases.push([{ ...base, DB_PORT: "54x2" }, /DB_PORT/]);
  cases.push([{ ...base, DB_SCHEMA: "pr-12; drop" }, /DB_SCHEMA/]);
  cases.push([{ ...base, PRINCIPAL_VERIFIED: "yes" }, /PRINCIPAL_VERIFIED/]);
  cases.push([{ ...base, PRINCIPAL_IDENTITY_MODE: "anonymous" }, /PRINCIPAL_IDENTITY_MODE/]);
  cases.push([{ ...base, PRINCIPAL_MONTHLY_BUDGET_MINOR: "500.5" }, /PRINCIPAL_MONTHLY_BUDGET_MINOR/]);
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
    env: { PATH: process.env["PATH"] ?? "", ...base, PORT: "0", MCP_BASE_PATH: "/mcp", DB_CA_BUNDLE: "/nonexistent/global-bundle.pem" },
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
