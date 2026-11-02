// What the mcp and worker containers receive (m1-protocol-connector D2, D3,
// D7; task 6.1; m1-hosted-connector tasks 7.1 to 7.3: no development
// principal, the resource server's settings and the limits). Pure mapping;
// the SST wiring is in mcp.ts and worker.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEED_DEV_BUDGET_MULTIPLIER, SEED_PRINCIPAL, SEED_PRINCIPAL_POLICY } from "../../packages/db/seed/simulated.ts";
import { CLEARING_SHARE, DEV_BUDGET_MULTIPLIER, developmentPolicy, developmentPrincipal, FEE_RATE, limitsFor, publicUrls, stageInfo } from "../config.ts";
import { AUTH_REQUIRED_BY_STAGE_KIND, authEnvironment, databaseEnvironment, PING_OPEN_BY_STAGE_KIND, plainEnvironment, serviceEnvNames, webBaseUrl } from "../service-env.ts";

const STAGES = ["dev", "prod", "pr-12"];

const AUTH_NAMES = ["AUTH_REQUIRED", "AUTH_ISSUER", "AUTH_JWKS_URL", "MCP_RESOURCE_URL", "PING_OPEN", "PING_MAX_CONCURRENT", "RATE_LIMIT_PER_MINUTE", "RATE_LIMIT_PER_DAY"];

test("no PRINCIPAL_* on either service any more: principals are rows (m1-hosted-connector task 7.2)", () => {
  for (const s of STAGES) {
    for (const service of ["mcp", "worker"] as const) {
      assert.deepEqual(Object.keys(plainEnvironment(service, stageInfo(s))).filter((k) => k.startsWith("PRINCIPAL_")), [], `${s} ${service}`);
      assert.deepEqual(serviceEnvNames(service, stageInfo(s)).filter((k) => k.startsWith("PRINCIPAL_")), []);
    }
  }
});

test("the seed's fallback principal dev-principal-<stage> has the development principal and policy (AUTH_REQUIRED=false)", () => {
  for (const s of STAGES) {
    const policy: Partial<ReturnType<typeof developmentPolicy>> = { ...developmentPolicy(stageInfo(s)) };
    delete policy.fee_rate;
    const seeded = { ...SEED_PRINCIPAL_POLICY, monthly_budget_minor: SEED_PRINCIPAL_POLICY.monthly_budget_minor * (s === "dev" ? SEED_DEV_BUDGET_MULTIPLIER : 1) };
    assert.deepEqual(seeded, policy, s);
    assert.deepEqual({ principal_id: `dev-principal-${s}`, ...SEED_PRINCIPAL }, developmentPrincipal(stageInfo(s)));
  }
  assert.equal(SEED_DEV_BUDGET_MULTIPLIER, DEV_BUDGET_MULTIPLIER);
});

test("mcp: resource-server switches and limits per stage (D3, D5); the worker gets none of them", () => {
  const env = (s: string) => plainEnvironment("mcp", stageInfo(s));
  // Task 8.3 flip (design D5): the verify jobs sign in through the mail sink
  // and hand A2H_TOKEN to the suites, so every stage kind runs the gate and
  // no stage opens the handshake, tools/list or `ping` to a tokenless client:
  // hosted clients meet the 401 on the handshake and start sign-in (D3).
  assert.deepEqual(
    ["dev", "pr-12", "prod"].map((s) => [env(s)["AUTH_REQUIRED"], env(s)["PING_OPEN"]]),
    [
      ["true", "false"],
      ["true", "false"],
      ["true", "false"],
    ],
  );
  // Both are stage configuration (D7), one table per switch, every kind listed.
  assert.deepEqual(AUTH_REQUIRED_BY_STAGE_KIND, { dev: true, pr: true, prod: true });
  assert.deepEqual(PING_OPEN_BY_STAGE_KIND, { dev: false, pr: false, prod: false });
  for (const s of STAGES) {
    assert.equal(env(s)["AUTH_REQUIRED"], String(AUTH_REQUIRED_BY_STAGE_KIND[stageInfo(s).kind]), s);
    assert.equal(env(s)["PING_OPEN"], String(PING_OPEN_BY_STAGE_KIND[stageInfo(s).kind]), s);
  }
  // design D5 (group 7): prod the owner's defaults; the test stages (dev and
  // previews) ten times the call limits, since their verify suites run as one principal.
  assert.deepEqual(
    STAGES.map((s) => [s, env(s)["RATE_LIMIT_PER_MINUTE"], env(s)["RATE_LIMIT_PER_DAY"], env(s)["PING_MAX_CONCURRENT"]]),
    [
      ["dev", "600", "20000", "4"],
      ["prod", "60", "2000", "4"],
      ["pr-12", "600", "20000", "4"],
    ],
  );
  // One source: the stage configuration in config.ts (task 8.1).
  for (const s of STAGES) {
    const l = limitsFor(stageInfo(s));
    assert.equal(env(s)["RATE_LIMIT_PER_MINUTE"], String(l.perMinute), s);
    assert.equal(env(s)["RATE_LIMIT_PER_DAY"], String(l.perDay), s);
    assert.equal(env(s)["PING_MAX_CONCURRENT"], String(l.pingMaxConcurrent), s);
    assert.equal(env(s)["EDGE_REQUESTS_PER_5_MINUTES"], undefined, "the edge limit is the WAF's, not the service's");
  }
  for (const s of STAGES) {
    const worker = serviceEnvNames("worker", stageInfo(s));
    for (const n of AUTH_NAMES) assert.ok(!worker.includes(n), `worker ${s} ${n}`);
    const mcp = serviceEnvNames("mcp", stageInfo(s));
    for (const n of AUTH_NAMES) assert.ok(mcp.includes(n), `mcp ${s} ${n}`);
  }
  assert.equal(AUTH_REQUIRED_BY_STAGE_KIND.prod, true, "prod never ships without the gate");
  assert.equal(PING_OPEN_BY_STAGE_KIND.prod, false, "prod never opens the handshake to a tokenless client");
});

test("mcp: issuer, JWKS and resource URL derived from the stage's hostnames (domain set)", () => {
  const domain = "a2h-protocol.org";
  const cases = [
    ["dev", "https://dev.a2h-protocol.org", "https://mcp.dev.a2h-protocol.org", "https://mcp.dev.a2h-protocol.org/mcp"],
    ["pr-12", "https://pr-12.dev.a2h-protocol.org", "https://mcp.dev.a2h-protocol.org", "https://mcp.dev.a2h-protocol.org/pr-12/mcp"],
    ["prod", "https://a2h-protocol.org", "https://mcp.a2h-protocol.org", "https://mcp.a2h-protocol.org/mcp"],
  ] as const;
  for (const [s, web, alb, resource] of cases) {
    const stage = stageInfo(s);
    assert.equal(webBaseUrl(stage, domain, "https://d111.cloudfront.net/"), web, s);
    assert.deepEqual(authEnvironment(stage, alb, web), {
      MCP_RESOURCE_URL: resource,
      AUTH_ISSUER: `${web}/api/auth`,
      AUTH_JWKS_URL: `${web}/api/auth/jwks`,
    });
  }
});

test("mcp: dev and pr-12 as index.ts wires them: resource = publicUrls().mcp, issuer = publicUrls().web + /api/auth (task 8.2)", () => {
  const domain = "a2h-protocol.org";
  for (const [s, resource, issuer] of [
    ["dev", "https://mcp.dev.a2h-protocol.org/mcp", "https://dev.a2h-protocol.org/api/auth"],
    ["pr-12", "https://mcp.dev.a2h-protocol.org/pr-12/mcp", "https://pr-12.dev.a2h-protocol.org/api/auth"],
  ] as const) {
    const stage = stageInfo(s);
    const urls = publicUrls(stage, domain);
    // index.ts: albBaseUrl() is publicUrls().albBase with a domain; the web URL is webBaseUrl() of the distribution URL.
    const env = authEnvironment(stage, urls.albBase, webBaseUrl(stage, domain, "https://d111.cloudfront.net"));
    assert.deepEqual(env, { MCP_RESOURCE_URL: resource, AUTH_ISSUER: issuer, AUTH_JWKS_URL: `${issuer}/jwks` }, s);
    assert.equal(env.MCP_RESOURCE_URL, urls.mcp, s);
    assert.equal(env.AUTH_ISSUER, `${urls.web}/api/auth`, s);
  }
});

test("mcp: without a domain the issuer is the web distribution's URL and the resource the load balancer's", () => {
  const stage = stageInfo("pr-12");
  assert.equal(webBaseUrl(stage, undefined, "https://d111.cloudfront.net/"), "https://d111.cloudfront.net");
  assert.deepEqual(authEnvironment(stage, "http://a2h-alb-123.eu-west-3.elb.amazonaws.com", "https://d111.cloudfront.net"), {
    MCP_RESOURCE_URL: "http://a2h-alb-123.eu-west-3.elb.amazonaws.com/pr-12/mcp",
    AUTH_ISSUER: "https://d111.cloudfront.net/api/auth",
    AUTH_JWKS_URL: "https://d111.cloudfront.net/api/auth/jwks",
  });
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

test("names per service: both get the database; only the worker the signing key, only mcp the approval key", () => {
  for (const s of STAGES) {
    const mcp = serviceEnvNames("mcp", stageInfo(s));
    const worker = serviceEnvNames("worker", stageInfo(s));
    for (const name of ["DB_HOST", "DB_PASSWORD", "DB_SCHEMA", "DB_JOBS_SCHEMA", "FEE_RATE", "STAGE"]) {
      assert.ok(mcp.includes(name), `mcp ${s} ${name}`);
      assert.ok(worker.includes(name), `worker ${s} ${name}`);
    }
    assert.ok(mcp.includes("APPROVAL_KEY"));
    // mcp verifies with public keys from signing_keys and never signs.
    for (const name of ["SIGNING_KEY_ID", "SIGNING_PRIVATE_KEY", "SIGNING_PUBLIC_KEY"]) {
      assert.ok(!mcp.includes(name), `mcp ${s} ${name}`);
      assert.ok(worker.includes(name), `worker ${s} ${name}`);
    }
    assert.ok(!worker.includes("APPROVAL_KEY"));
    assert.ok(worker.includes("SIMULATOR_ENABLED"));
    assert.deepEqual(mcp, [...new Set(mcp)].sort());
  }
});
