// The owner-applied IAM documents (infra/bootstrap/*.json) against what
// m1-hosted-connector (and PR #52) create at deploy time and call at run time.
// Deploy roles: PowerUserAccess (runbook §3) plus the inline
// gha-a2h-deploy-iam.json, which only adds IAM on role/a2h-*. Workload roles
// (every role SST creates): capped by a2h-workload-boundary.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allowlistParameterName, roleName, stageInfo } from "../config.ts";
import { fileEventsQueueName, SCANNER_ROLE_LOGICAL_NAME, scannerRoleArn, scannerRolePolicy, WORKER_QUEUE_ACTIONS } from "../files.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ACCOUNT = "442123849268";

interface Statement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}
const load = (f: string): Statement[] =>
  (JSON.parse(readFileSync(`${ROOT}/infra/bootstrap/${f}`, "utf8")) as { Statement: Statement[] }).Statement;
const boundary = load("a2h-workload-boundary.json");
const deploy = load("gha-a2h-deploy-iam.json");
const list = (v: string | string[]) => [v].flat();
const glob = (pattern: string, value: string) =>
  new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);

/** Is `action` on `resource` allowed by an Allow statement without conditions, and not denied? */
function allows(doc: Statement[], action: string, resource: string): boolean {
  const hit = (s: Statement) => list(s.Action).some((a) => glob(a, action)) && list(s.Resource).some((r) => glob(r, resource));
  if (doc.some((s) => s.Effect === "Deny" && hit(s))) return false;
  return doc.some((s) => s.Effect === "Allow" && hit(s));
}

// SST 4.17.2 aurora.ts: the cluster is `${name}Cluster`, physical name
// `a2h-<stage>-databasecluster-<8>` (component.ts: aws:rds/cluster:Cluster,
// clusterIdentifier, lower case). The Data API actions are those SST's own
// `link` on an Aurora grants (aurora.ts getSSTLink).
const DATA_API = [
  "rds-data:BatchExecuteStatement",
  "rds-data:BeginTransaction",
  "rds-data:CommitTransaction",
  "rds-data:ExecuteStatement",
  "rds-data:RollbackTransaction",
];

test("boundary: the web function may use the Data API on A2H clusters in eu-west-3 only (design D2)", () => {
  for (const stage of ["dev", "prod"]) {
    const cluster = `arn:aws:rds:eu-west-3:${ACCOUNT}:cluster:a2h-${stage}-databasecluster-abcdefgh`;
    for (const a of DATA_API) assert.ok(allows(boundary, a, cluster), `${a} on ${cluster}`);
  }
  assert.ok(!allows(boundary, "rds-data:ExecuteStatement", `arn:aws:rds:eu-west-3:${ACCOUNT}:cluster:other-db`));
  assert.ok(!allows(boundary, "rds-data:ExecuteStatement", `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:a2h-dev-databasecluster-x`));
  // The Data API reads the credentials secret with the caller's rights: master (dev/prod) and per-PR login.
  for (const secret of [`a2h-dev-DatabaseProxySecret-AbC123`, `a2h/pr-12/db-AbC123`]) {
    assert.ok(allows(boundary, "secretsmanager:GetSecretValue", `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:${secret}`), secret);
  }
  // Nothing else of rds-data or rds.
  const rdsActions = boundary.filter((s) => s.Effect === "Allow").flatMap((s) => list(s.Action)).filter((a) => a.startsWith("rds"));
  assert.deepEqual(rdsActions.filter((a) => a.startsWith("rds-data:")).sort(), DATA_API);
  assert.ok(!rdsActions.some((a) => a.endsWith(":*")), "no rds wildcard");
});

test("boundary: the web function may read the allow-list (D7); SecureString with aws/ssm is decrypted through SSM only", () => {
  for (const s of ["dev", "pr-12", "prod"]) {
    const arn = `arn:aws:ssm:eu-west-3:${ACCOUNT}:parameter${allowlistParameterName(stageInfo(s))}`;
    assert.ok(allows(boundary, "ssm:GetParameter", arn), arn);
    // Workloads never write it: the owner does (runbook §15).
    assert.ok(!allows(boundary, "ssm:PutParameter", arn), arn);
  }
  const decrypt = boundary.find((s) => s.Effect === "Allow" && list(s.Action).includes("kms:Decrypt"));
  assert.ok(decrypt);
  assert.ok(list(decrypt.Condition?.["StringEquals"]?.["kms:ViaService"] ?? []).includes("ssm.eu-west-3.amazonaws.com"));
});

test("boundary: no IAM, no role assumption, no action or service wildcard on every resource", () => {
  for (const s of boundary.filter((x) => x.Effect === "Allow")) {
    for (const a of list(s.Action)) {
      assert.notEqual(a, "*", s.Sid);
      assert.ok(!a.startsWith("iam:") && !a.startsWith("sts:"), `${s.Sid}: ${a}`);
      // A service-wide wildcard is only acceptable on A2H-named resources.
      if (a.endsWith(":*")) assert.ok(list(s.Resource).every((r) => r !== "*" && /a2h-/.test(r)), `${s.Sid}: ${a} on ${String(s.Resource)}`);
    }
  }
  assert.ok(boundary.some((s) => s.Effect === "Deny" && list(s.Action).includes("iam:*")), "boundary denies iam:*");
  // IAM: a managed policy is at most 6,144 characters without whitespace.
  const compact = JSON.stringify(JSON.parse(readFileSync(`${ROOT}/infra/bootstrap/a2h-workload-boundary.json`, "utf8")));
  assert.ok(compact.length <= 6144, `boundary is ${compact.length} characters`);
  // Workloads do not manage WAF, DNS, certificates or SES identities: those are deploy-time only.
  for (const a of ["wafv2:CreateWebACL", "route53:ChangeResourceRecordSets", "acm:RequestCertificate", "ses:CreateEmailIdentity", "rds:ModifyDBCluster"]) {
    assert.ok(!allows(boundary, a, "*") && !allows(boundary, a, `arn:aws:${a.split(":")[0]}:eu-west-3:${ACCOUNT}:anything/a2h-x`), a);
  }
});

test("deploy roles: PowerUserAccess covers what this change deploys; the inline policy adds IAM on role/a2h-* only", () => {
  const runbook = readFileSync(`${ROOT}/docs/runbooks/aws-bootstrap.md`, "utf8");
  assert.match(runbook, /attach-role-policy[^\n]*\\\n[^\n]*policy\/PowerUserAccess/, "§3 attaches PowerUserAccess to both deploy roles");
  // PowerUserAccess = Allow NotAction [iam:*, organizations:*, account:*] on "*" (plus a few IAM and
  // account reads), so every non-IAM call below is allowed unless the inline policy denies it.
  const deployTime = [
    "wafv2:CreateWebACL",
    "wafv2:UpdateWebACL",
    "wafv2:DeleteWebACL",
    "wafv2:GetWebACL",
    "wafv2:AssociateWebACL",
    "wafv2:DisassociateWebACL",
    "wafv2:TagResource",
    "elasticloadbalancing:SetWebAcl",
    "cloudfront:UpdateDistribution",
    "route53:ChangeResourceRecordSets",
    "route53:ListResourceRecordSets",
    "route53:GetChange",
    "acm:RequestCertificate",
    "acm:DescribeCertificate",
    "acm:DeleteCertificate",
    "ses:CreateEmailIdentity",
    "ses:PutEmailIdentityDkimSigningAttributes",
    "ses:CreateConfigurationSet",
    "ssm:PutParameter",
    "ssm:GetParameter",
    "ssm:AddTagsToResource",
    "kms:Encrypt",
    "kms:Decrypt",
    "rds:ModifyDBCluster",
    "rds:EnableHttpEndpoint",
  ];
  for (const a of deployTime) {
    assert.ok(!["iam", "organizations", "account"].includes(a.split(":")[0] ?? ""), a);
    assert.ok(!deploy.some((s) => s.Effect === "Deny" && list(s.Action).some((p) => glob(p, a))), `inline policy denies ${a}`);
  }
  // WAF (no logging), ACM, Route 53 and SES create no role: the workloads' PassRole stays ECS tasks and Lambda.
  const pass = deploy.find((s) => s.Sid === "PassA2HRolesToWorkloadsOnly");
  assert.ok(pass);
  assert.deepEqual(list(pass.Condition?.["StringEquals"]?.["iam:PassedToService"] ?? []).sort(), ["ecs-tasks.amazonaws.com", "lambda.amazonaws.com"]);
  for (const s of deploy.filter((x) => x.Effect === "Allow")) {
    for (const a of list(s.Action)) {
      assert.notEqual(a, "*", s.Sid);
      assert.notEqual(a, "iam:*", s.Sid);
      if (list(s.Resource).includes("*")) {
        assert.ok(s.Condition || !/^iam:(Create|Put|Attach|Delete|Update|Pass)/.test(a), `${s.Sid}: ${a} on *`);
      }
    }
  }
});

// ---- m2-attachments (ADR 0005; task 3.1) ----------------------------------------

/** Every action on every concrete resource the scanner role's policy names (wildcards made concrete). */
function scannerNeeds(): [string, string][] {
  const bucket = "a2h-dev-uploadsbucket-vnkxkhnk";
  const concrete = (r: string) => r.replace("DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*", "DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3-ab12").replace(/\/tmp\/\*$/, "/tmp/dev/files/A2H-7f3c/fAAAAAAAAAAAAAAAAAAAAAA");
  return scannerRolePolicy(bucket, ACCOUNT).Statement.flatMap((s) => s.Action.flatMap((a) => s.Resource.map((r): [string, string] => [a, concrete(r)])));
}

test("boundary: the scanner's role (created by dev's and prod's stacks under the boundary) may do everything GuardDuty's template needs", () => {
  for (const [action, resource] of scannerNeeds()) assert.ok(allows(boundary, action, resource), `${action} on ${resource}`);
  // The managed rule only: not any EventBridge rule in the account.
  assert.ok(!allows(boundary, "events:PutRule", `arn:aws:events:eu-west-3:${ACCOUNT}:rule/a2h-dev-file-created`));
  assert.ok(!allows(boundary, "events:PutTargets", `arn:aws:events:eu-west-3:${ACCOUNT}:rule/anything`));
  assert.ok(!allows(boundary, "events:PutRule", `arn:aws:events:us-east-1:${ACCOUNT}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3-ab12`), "eu-west-3 only");
});

test("boundary: the worker reads and deletes on its stage's file-events queue", () => {
  for (const s of ["dev", "pr-12", "prod"]) {
    const queue = `arn:aws:sqs:eu-west-3:${ACCOUNT}:${fileEventsQueueName(stageInfo(s))}`;
    for (const a of WORKER_QUEUE_ACTIONS) assert.ok(allows(boundary, a, queue), `${a} on ${queue}`);
  }
});

test("deploy roles: may pass the scanner role to the Malware Protection plan service only (CreateMalwareProtectionPlan needs iam:PassRole)", () => {
  const scanner = deploy.find((s) => s.Sid === "PassScannerRoleToMalwareProtectionOnly");
  assert.ok(scanner, "statement PassScannerRoleToMalwareProtectionOnly");
  assert.deepEqual(list(scanner.Action), ["iam:PassRole"]);
  assert.deepEqual(list(scanner.Condition?.["StringEquals"]?.["iam:PassedToService"] ?? []), ["malware-protection-plan.guardduty.amazonaws.com"]);
  for (const s of ["dev", "prod"]) {
    const arn = scannerRoleArn(stageInfo(s), ACCOUNT);
    assert.ok(list(scanner.Resource).some((r) => glob(r, arn)), arn);
  }
  // role/a2h-* like every other deploy statement (tests/ci/bootstrap.test.mjs); never a deploy role.
  assert.deepEqual(list(scanner.Resource), [`arn:aws:iam::${ACCOUNT}:role/a2h-*`]);
  assert.ok(!list(scanner.Resource).some((r) => glob(r, `arn:aws:iam::${ACCOUNT}:role/gha-a2h-dev`)));
  // The scanner role is created like every a2h-* role: with the boundary (CreateOrChangeA2HRolesOnlyWithBoundary).
  assert.ok(glob("a2h-*", roleName("dev", SCANNER_ROLE_LOGICAL_NAME)));
});
