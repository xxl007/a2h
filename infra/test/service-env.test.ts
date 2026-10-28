// What the mcp and worker containers receive (m1-protocol-connector D2, D3,
// D7; task 6.1). Pure mapping; the SST wiring is in mcp.ts and worker.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrincipalSchema, ValidationPolicySchema } from "../../packages/protocol/src/index.ts";
import { CLEARING_SHARE, DEVELOPMENT_POLICY, developmentPrincipal, FEE_RATE, stageInfo } from "../config.ts";
import { databaseEnvironment, plainEnvironment, serviceEnvNames } from "../service-env.ts";

const STAGES = ["dev", "prod", "pr-12"];

/** The inverse an app adapter will implement: env -> protocol shapes. */
function policyFromEnv(env: Record<string, string>) {
  const int = (k: string) => Number(env[k]);
  const askFirst = env["PRINCIPAL_ASK_FIRST_ABOVE_MINOR"];
  return {
    principal: {
      principal_id: env["PRINCIPAL_ID"],
      identity_mode: env["PRINCIPAL_IDENTITY_MODE"],
      verified: env["PRINCIPAL_VERIFIED"] === "true",
    },
    policy: {
      fee_rate: Number(env["FEE_RATE"]),
      currency: env["PRINCIPAL_CURRENCY"],
      monthly_budget_minor: int("PRINCIPAL_MONTHLY_BUDGET_MINOR"),
      per_request_cap_minor: int("PRINCIPAL_PER_REQUEST_CAP_MINOR"),
      ask_first_above_minor: askFirst === "none" ? null : Number(askFirst),
      daily_request_limit: int("PRINCIPAL_DAILY_REQUEST_LIMIT"),
      throttled_daily_limit: int("PRINCIPAL_THROTTLED_DAILY_LIMIT"),
    },
  };
}

test("policy environment round-trips to the protocol's ValidationPolicy and Principal (D7)", () => {
  for (const s of STAGES) {
    for (const service of ["mcp", "worker"] as const) {
      const { principal, policy } = policyFromEnv(plainEnvironment(service, stageInfo(s)));
      assert.deepEqual(ValidationPolicySchema.parse(policy), DEVELOPMENT_POLICY, `${s} ${service}`);
      assert.deepEqual(PrincipalSchema.parse(principal), developmentPrincipal(stageInfo(s)), `${s} ${service}`);
    }
  }
});

test("FEE_RATE, CLEARING_SHARE, STAGE as plain environment on both services", () => {
  for (const s of STAGES) {
    for (const service of ["mcp", "worker"] as const) {
      const env = plainEnvironment(service, stageInfo(s));
      assert.equal(env["FEE_RATE"], String(FEE_RATE));
      assert.equal(env["CLEARING_SHARE"], String(CLEARING_SHARE));
      assert.equal(env["STAGE"], s);
    }
  }
});

test("SIMULATOR_ENABLED: worker only, false on prod, true elsewhere", () => {
  assert.equal(plainEnvironment("worker", stageInfo("prod"))["SIMULATOR_ENABLED"], "false");
  assert.equal(plainEnvironment("worker", stageInfo("dev"))["SIMULATOR_ENABLED"], "true");
  assert.equal(plainEnvironment("worker", stageInfo("pr-12"))["SIMULATOR_ENABLED"], "true");
  for (const s of STAGES) assert.equal(plainEnvironment("mcp", stageInfo(s))["SIMULATOR_ENABLED"], undefined);
});

test("database environment: DB_SCHEMA and DB_JOBS_SCHEMA per stage (D2, D3), never a password", () => {
  const endpoint = { host: "h", port: "5432", name: "a2h" };
  assert.deepEqual(databaseEnvironment(endpoint, "pr_12", stageInfo("pr-12")), {
    DB_HOST: "h",
    DB_PORT: "5432",
    DB_NAME: "a2h",
    DB_USER: "pr_12",
    DB_SCHEMA: "pr_12",
    DB_JOBS_SCHEMA: "pr_12_jobs",
  });
  assert.equal(databaseEnvironment(endpoint, "u", stageInfo("dev"))["DB_JOBS_SCHEMA"], "pgboss");
});

test("no secret in plain environment: no value looks like key material, no *_KEY or *_PASSWORD name", () => {
  for (const s of STAGES) {
    for (const service of ["mcp", "worker"] as const) {
      const env = plainEnvironment(service, stageInfo(s));
      for (const [k, v] of Object.entries(env)) {
        assert.equal(typeof v, "string", k);
        assert.doesNotMatch(k, /(_KEY|PASSWORD|SECRET)$/, k);
      }
    }
  }
});

test("names per service: mcp and worker both get the database and the signing key; only mcp the approval key", () => {
  for (const s of STAGES) {
    const mcp = serviceEnvNames("mcp", stageInfo(s));
    const worker = serviceEnvNames("worker", stageInfo(s));
    for (const name of ["DB_HOST", "DB_PASSWORD", "DB_SCHEMA", "DB_JOBS_SCHEMA", "SIGNING_KEY_ID", "SIGNING_PRIVATE_KEY", "SIGNING_PUBLIC_KEY", "FEE_RATE", "STAGE"]) {
      assert.ok(mcp.includes(name), `mcp ${s} ${name}`);
      assert.ok(worker.includes(name), `worker ${s} ${name}`);
    }
    assert.ok(mcp.includes("APPROVAL_KEY"));
    assert.ok(!worker.includes("APPROVAL_KEY"));
    assert.ok(worker.includes("SIMULATOR_ENABLED"));
    assert.deepEqual(mcp, [...new Set(mcp)].sort());
  }
});
