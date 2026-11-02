// What the web Lambda receives (m1-hosted-connector tasks 5.1-5.3; design D1,
// D2, D6, D7). Pure mapping; the SST wiring is in web.ts. apps/web's own test
// (apps/web/test/infra-env.test.ts) parses this environment with the app's
// configuration reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { developmentPolicy, stageInfo } from "../config.ts";
import {
  authIssuer,
  RDS_DATA_ACTIONS,
  secretArnFromValueFrom,
  webDatabasePermissions,
  webPlainEnvironment,
} from "../web-env.ts";

const ACCOUNT = "123456789012";
const CLUSTER = `arn:aws:rds:eu-west-3:${ACCOUNT}:cluster:a2h-dev-databasecluster-abc`;
const MASTER = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:a2h-dev-DatabaseSecret-AbC123`;
const PR_SECRET = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:a2h/pr-12/db-XyZ789`;

test("issuer: https://<web host>/api/auth when the stage has a domain; none without", () => {
  assert.equal(authIssuer(stageInfo("dev"), "a2h-protocol.org"), "https://dev.a2h-protocol.org/api/auth");
  assert.equal(authIssuer(stageInfo("pr-12"), "a2h-protocol.org"), "https://pr-12.dev.a2h-protocol.org/api/auth");
  assert.equal(authIssuer(stageInfo("prod"), "a2h-protocol.org"), "https://a2h-protocol.org/api/auth");
  assert.equal(authIssuer(stageInfo("dev"), undefined), undefined);
});

test("allow-list parameter: one per stage (D7; task 8.3 fact: a preview has its own)", () => {
  assert.equal(webPlainEnvironment(stageInfo("pr-12"), {})["ALLOWLIST_PARAMETER"], "/a2h/pr-12/principal-allowlist");
  assert.equal(webPlainEnvironment(stageInfo("dev"), {})["ALLOWLIST_PARAMETER"], "/a2h/shared/principal-allowlist");
  assert.equal(webPlainEnvironment(stageInfo("prod"), {})["ALLOWLIST_PARAMETER"], "/a2h/prod/principal-allowlist");
});

test("plain environment: the stage default policy in the mcp service's variable names, the database name and schema", () => {
  for (const s of ["dev", "prod", "pr-12"]) {
    const stage = stageInfo(s);
    const env = webPlainEnvironment(stage, { domain: "a2h-protocol.org", emailSender: "a2h-protocol.org" });
    const p = developmentPolicy(stage);
    assert.equal(env["PRINCIPAL_CURRENCY"], p.currency);
    assert.equal(env["PRINCIPAL_MONTHLY_BUDGET_MINOR"], String(p.monthly_budget_minor));
    assert.equal(env["PRINCIPAL_PER_REQUEST_CAP_MINOR"], String(p.per_request_cap_minor));
    assert.equal(env["PRINCIPAL_ASK_FIRST_ABOVE_MINOR"], p.ask_first_above_minor === null ? "none" : String(p.ask_first_above_minor));
    assert.equal(env["PRINCIPAL_DAILY_REQUEST_LIMIT"], String(p.daily_request_limit));
    assert.equal(env["PRINCIPAL_THROTTLED_DAILY_LIMIT"], String(p.throttled_daily_limit));
    assert.equal(env["DB_NAME"], "a2h");
    assert.equal(env["DB_SCHEMA"], stage.dbSchema);
    assert.equal(env["EMAIL_FROM"], "A2H <sign-in@a2h-protocol.org>");
    // Deployed stages read the SSM parameter only (PR #57 creates it); the fallback is for local runs.
    assert.equal(env["PRINCIPAL_ALLOWLIST"], undefined);
    assert.ok(env["AUTH_ISSUER"]?.endsWith("/api/auth"));
    // No principal of the stage and no fee: those are the mcp service's.
    for (const name of ["PRINCIPAL_ID", "PRINCIPAL_VERIFIED", "FEE_RATE"]) assert.equal(env[name], undefined, `${s} ${name}`);
  }
});

test("no sender yet: EMAIL_FROM is absent off prod (the sink needs none)", () => {
  assert.equal(webPlainEnvironment(stageInfo("pr-12"), { emailSender: "none" })["EMAIL_FROM"], undefined);
  assert.equal(webPlainEnvironment(stageInfo("pr-12"), { emailSender: "owner@example.com" })["EMAIL_FROM"], "A2H <owner@example.com>");
});

test("the secret ARN comes from the ECS valueFrom the stage already uses (no second lookup)", () => {
  assert.equal(secretArnFromValueFrom(`${PR_SECRET}:password::`), PR_SECRET);
  assert.equal(secretArnFromValueFrom(`${MASTER}:password::`), MASTER);
  assert.throws(() => secretArnFromValueFrom("arn:aws:s3:::b"));
});

test("IAM: Data API on the cluster, the stage's own database secret, the allow-list parameter", () => {
  const pr = webDatabasePermissions(stageInfo("pr-12"), { clusterArn: CLUSTER, secretArn: PR_SECRET, accountId: ACCOUNT });
  assert.deepEqual(pr, [
    { actions: [...RDS_DATA_ACTIONS], resources: [CLUSTER] },
    { actions: ["secretsmanager:GetSecretValue"], resources: [PR_SECRET] },
    { actions: ["ssm:GetParameter"], resources: [`arn:aws:ssm:eu-west-3:${ACCOUNT}:parameter/a2h/pr-12/principal-allowlist`] },
  ]);
  // A preview never reads the master secret.
  assert.throws(() => webDatabasePermissions(stageInfo("pr-12"), { clusterArn: CLUSTER, secretArn: MASTER, accountId: ACCOUNT }), /a2h\/pr-12\/db/);
  const dev = webDatabasePermissions(stageInfo("dev"), { clusterArn: CLUSTER, secretArn: MASTER, accountId: ACCOUNT });
  assert.deepEqual(dev[1], { actions: ["secretsmanager:GetSecretValue"], resources: [MASTER] });
  assert.deepEqual(RDS_DATA_ACTIONS, [
    "rds-data:BatchExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:ExecuteStatement",
    "rds-data:RollbackTransaction",
  ]);
});
