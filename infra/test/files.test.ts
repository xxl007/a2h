// m2-attachments task 3.1 (design D2, D3, D6, D9; ADR 0005 items 1 to 8):
// the uploads bucket's CORS, the prefix-scoped grants of web and worker, the
// tag-based bucket policy, the scanner's role, the per-stage event routing
// and the alarms. Pure: no SST globals, no AWS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { roleName, stageInfo } from "../config.ts";
import {
  FILE_EVENT_QUEUE_POLICY_ACTIONS,
  SCAN_TAG,
  SCAN_TAG_CLEAN,
  SCANNED_PREFIX,
  SCANNER_ROLE_LOGICAL_NAME,
  WORKER_QUEUE_ACTIONS,
  fileEventPatterns,
  fileEventsQueueName,
  scanAlertPatterns,
  scannerRoleArn,
  scannerRolePolicy,
  scannerTrustPolicy,
  storagePermissions,
  uploadsBucketPolicy,
  uploadsCors,
  workerRoleArnPattern,
} from "../files.ts";

const BUCKET = "a2h-dev-uploadsbucket-vnkxkhnk";
const ACCOUNT = "442123849268";
const DOMAIN = "a2h-protocol.org";

/** IAM-style wildcard match (`*` any sequence, `?` one character). */
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(value);
}

// ---- CORS (D2) -----------------------------------------------------------------

test("CORS: POST only, from the bucket owner's web origin and (dev) its previews' origins; nothing else", () => {
  assert.deepEqual(uploadsCors(stageInfo("dev"), DOMAIN), {
    allowMethods: ["POST"],
    allowOrigins: [`https://dev.${DOMAIN}`, `https://pr-*.dev.${DOMAIN}`],
    allowHeaders: ["*"],
    maxAge: "1 hour",
  });
  const originsOf = (name: string) => {
    const cors = uploadsCors(stageInfo(name), DOMAIN);
    assert.ok(cors);
    return cors.allowOrigins;
  };
  assert.deepEqual(originsOf("prod"), [`https://${DOMAIN}`]);
  // A preview's origin matches dev's wildcard; an arbitrary site does not.
  const origins = originsOf("dev");
  assert.ok(origins.some((o) => globMatch(o, `https://pr-104.dev.${DOMAIN}`)));
  for (const o of ["https://evil.example", `https://dev.${DOMAIN}.evil.example`, "http://dev.a2h-protocol.org", "*"]) assert.ok(!origins.some((p) => globMatch(p, o)), o);
  // Without a domain no origin is known: no browser upload rather than "*".
  assert.equal(uploadsCors(stageInfo("dev"), undefined), false);
  assert.throws(() => uploadsCors(stageInfo("pr-12"), DOMAIN), /owner/);
});

// ---- grants (D2, D3, D5, D6; ADR 0005 item 7) ----------------------------------

test("web: write tmp/<prefix>files/, read uploads/<prefix>files/ only when tagged clean, delete either (removal), and the mail sink; nothing in tmp/ readable", () => {
  for (const name of ["dev", "pr-12", "prod"]) {
    const s = stageInfo(name);
    const p = s.storagePrefix;
    assert.deepEqual(storagePermissions("web", s, BUCKET), [
      { actions: ["s3:PutObject"], resources: [`arn:aws:s3:::${BUCKET}/tmp/${p}files/*`] },
      {
        actions: ["s3:GetObject"],
        resources: [`arn:aws:s3:::${BUCKET}/uploads/${p}files/*`],
        conditions: [{ test: "StringEquals", variable: `s3:ExistingObjectTag/${SCAN_TAG}`, values: [SCAN_TAG_CLEAN] }],
      },
      { actions: ["s3:DeleteObject"], resources: [`arn:aws:s3:::${BUCKET}/tmp/${p}files/*`, `arn:aws:s3:::${BUCKET}/uploads/${p}files/*`] },
      { actions: ["s3:PutObject"], resources: [`arn:aws:s3:::${BUCKET}/tmp/${p}mail/*`] },
    ]);
  }
  assert.equal(SCAN_TAG, "GuardDutyMalwareScanStatus");
  assert.equal(SCAN_TAG_CLEAN, "NO_THREATS_FOUND");
  const flat = JSON.stringify(storagePermissions("web", stageInfo("pr-12"), BUCKET));
  assert.ok(!flat.includes("s3:*") && !flat.includes("ListBucket") && !flat.includes("Tagging"), flat);
});

test("worker: read, write, delete and copy-with-tags in both files areas of its own prefix only", () => {
  const s = stageInfo("pr-12");
  assert.deepEqual(storagePermissions("worker", s, BUCKET), [
    {
      actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectTagging", "s3:PutObjectTagging"],
      resources: [`arn:aws:s3:::${BUCKET}/tmp/pr-12/files/*`, `arn:aws:s3:::${BUCKET}/uploads/pr-12/files/*`],
    },
  ]);
});

test("mcp: no storage access at all (agents never read files)", () => {
  for (const name of ["dev", "pr-12", "prod"]) assert.deepEqual(storagePermissions("mcp", stageInfo(name), BUCKET), []);
});

test("no grant of a preview covers another stage's keys", () => {
  const resources = (["web", "worker"] as const).flatMap((svc) => storagePermissions(svc, stageInfo("pr-12"), BUCKET).flatMap((p) => p.resources));
  for (const key of ["tmp/pr-120/files/A2H-0001/fx", "uploads/dev/files/A2H-0001/fx", "tmp/dev/mail/x.json", "uploads/prod/files/A2H-0001/fx"]) {
    assert.ok(!resources.some((r) => globMatch(r, `arn:aws:s3:::${BUCKET}/${key}`)), key);
  }
  assert.throws(() => storagePermissions("web", stageInfo("pr-12"), "Bad/Name"), /bucket/);
});

// ---- the scanner (ADR 0005 items 1 to 3) ---------------------------------------

test("protected prefix: tmp/ only (literal, covers every stage's tmp/<prefix>files/; uploads/ not scanned twice)", () => {
  assert.equal(SCANNED_PREFIX, "tmp/");
  for (const name of ["dev", "pr-12", "prod"]) assert.ok(`tmp/${stageInfo(name).storagePrefix}files/x`.startsWith(SCANNED_PREFIX));
  assert.ok(!`uploads/dev/files/x`.startsWith(SCANNED_PREFIX));
});

test("scanner role: trusted by the Malware Protection plan service only; its ARN follows roleName() so the bucket policy can name it", () => {
  assert.deepEqual(scannerTrustPolicy(), {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "malware-protection-plan.guardduty.amazonaws.com" }, Action: "sts:AssumeRole" }],
  });
  assert.equal(scannerRoleArn(stageInfo("dev"), ACCOUNT), `arn:aws:iam::${ACCOUNT}:role/${roleName("dev", SCANNER_ROLE_LOGICAL_NAME)}`);
  assert.match(scannerRoleArn(stageInfo("dev"), ACCOUNT), /:role\/a2h-dev-/);
  assert.throws(() => scannerRoleArn(stageInfo("pr-12"), ACCOUNT), /owner/);
});

test("scanner role policy: the AWS template, scoped to this bucket, tmp/ and the managed rule", () => {
  const policy = scannerRolePolicy(BUCKET, ACCOUNT);
  const bySid = Object.fromEntries(policy.Statement.map((s) => [s.Sid, s]));
  assert.deepEqual(bySid["ManagedRule"]?.Resource, [`arn:aws:events:eu-west-3:${ACCOUNT}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`]);
  assert.deepEqual(bySid["ManagedRule"]?.Action, ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"]);
  assert.deepEqual(bySid["ManagedRule"]?.Condition, { StringLike: { "events:ManagedBy": "malware-protection-plan.guardduty.amazonaws.com" } });
  assert.deepEqual(bySid["ManagedRuleRead"]?.Action, ["events:DescribeRule", "events:ListTargetsByRule"]);
  assert.deepEqual(bySid["Scan"]?.Resource, [`arn:aws:s3:::${BUCKET}/tmp/*`, `arn:aws:s3:::${BUCKET}/malware-protection-resource-validation-object`]);
  assert.deepEqual(bySid["Tag"]?.Resource, [`arn:aws:s3:::${BUCKET}/tmp/*`]);
  assert.deepEqual(bySid["ValidationObject"]?.Resource, [`arn:aws:s3:::${BUCKET}/malware-protection-resource-validation-object`]);
  assert.deepEqual(bySid["BucketNotification"]?.Action, ["s3:PutBucketNotification", "s3:GetBucketNotification"]);
  assert.deepEqual(bySid["BucketOwnership"]?.Action, ["s3:ListBucket"]);
  for (const s of policy.Statement) for (const r of s.Resource) assert.ok(!r.startsWith(`arn:aws:s3:::${BUCKET}/uploads`), "never the uploads area");
  // No KMS: the bucket is SSE-S3.
  assert.ok(!JSON.stringify(policy).includes("kms:"));
});

// ---- the bucket policy (ADR 0005 item 7) ---------------------------------------

test("bucket policy: unscanned files in tmp/ are unreadable to all but the scanner and the workers; only the scanner sets the scan tag in tmp/", () => {
  const scanner = scannerRoleArn(stageInfo("dev"), ACCOUNT);
  const statements = uploadsBucketPolicy({ scannerRoleArn: scanner, accountId: ACCOUNT });
  assert.deepEqual(statements, [
    {
      effect: "deny",
      principals: "*",
      actions: ["s3:GetObject", "s3:GetObjectVersion"],
      paths: ["tmp/*/files/*"],
      conditions: [
        { test: "StringNotEquals", variable: `s3:ExistingObjectTag/${SCAN_TAG}`, values: [SCAN_TAG_CLEAN] },
        { test: "ArnNotLike", variable: "aws:PrincipalArn", values: [scanner, workerRoleArnPattern(ACCOUNT)] },
      ],
    },
    {
      effect: "deny",
      principals: "*",
      actions: ["s3:PutObject", "s3:PutObjectTagging", "s3:PutObjectVersionTagging"],
      paths: ["tmp/*"],
      conditions: [
        { test: "ForAnyValue:StringEquals", variable: "s3:RequestObjectTagKeys", values: [SCAN_TAG] },
        { test: "ArnNotLike", variable: "aws:PrincipalArn", values: [scanner] },
      ],
    },
  ]);
});

test("the worker exemption matches every stage's worker task role and no other role", () => {
  const pattern = workerRoleArnPattern(ACCOUNT);
  const arn = (stage: string, logical: string) => `arn:aws:iam::${ACCOUNT}:role/${roleName(stage, logical)}`;
  for (const [stage, logical] of [["dev", "WorkerTaskRole"], ["prod", "WorkerTaskRole"], ["pr-12", "WorkerPr12TaskRole"], ["pr-105", "WorkerPr105TaskRole"]] as const) {
    assert.ok(globMatch(pattern, arn(stage, logical)), `${stage} ${logical}`);
  }
  for (const [stage, logical] of [
    ["dev", "WorkerExecutionRole"],
    ["pr-12", "WorkerPr12ExecutionRole"],
    ["dev", "McpTaskRole"],
    ["pr-12", "McpPr12TaskRole"],
    ["dev", "WebServerEuwest3Role"],
  ] as const) {
    assert.ok(!globMatch(pattern, arn(stage, logical)), `${stage} ${logical}`);
  }
  assert.ok(!globMatch(pattern, "arn:aws:iam::442123849268:role/gha-a2h-preview"));
  assert.ok(!globMatch(pattern, "arn:aws:iam::999999999999:role/a2h-dev-WorkerTaskRole-ed50159a"), "another account");
});

// ---- event routing (ADR 0005 item 4) -------------------------------------------

test("per-stage rules: S3 Object Created and GuardDuty scan results for this bucket's tmp/<prefix>files/ only", () => {
  const patterns = fileEventPatterns(BUCKET, stageInfo("pr-12"));
  assert.deepEqual(patterns, {
    created: {
      source: ["aws.s3"],
      "detail-type": ["Object Created"],
      detail: { bucket: { name: [BUCKET] }, object: { key: [{ prefix: "tmp/pr-12/files/" }] } },
    },
    scanned: {
      source: ["aws.guardduty"],
      "detail-type": ["GuardDuty Malware Protection Object Scan Result"],
      detail: { s3ObjectDetails: { bucketName: [BUCKET], objectKey: [{ prefix: "tmp/pr-12/files/" }] } },
    },
  });
  // pr-1's prefix is not a prefix of pr-12's keys and vice versa: the trailing slash.
  const one = fileEventPatterns(BUCKET, stageInfo("pr-1")).created.detail.object.key[0].prefix;
  assert.ok(!"tmp/pr-12/files/A2H-0001/fx".startsWith(one));
});

test("the stage's queue: named a2h-<stage>-… (the workload boundary allows sqs on a2h-*), EventBridge may send only from the stage's rules, the worker may receive and delete", () => {
  assert.equal(fileEventsQueueName(stageInfo("pr-12")), "a2h-pr-12-file-events");
  assert.equal(fileEventsQueueName(stageInfo("dev")), "a2h-dev-file-events");
  assert.deepEqual(FILE_EVENT_QUEUE_POLICY_ACTIONS, ["sqs:SendMessage"]);
  assert.deepEqual(WORKER_QUEUE_ACTIONS, ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]);
});

// ---- alarms (ADR 0005 item 8) --------------------------------------------------

test("alarms: a plan status other than ACTIVE, and any post-scan action failure", () => {
  assert.deepEqual(scanAlertPatterns(), {
    status: { source: ["aws.guardduty"], "detail-type": [{ prefix: "GuardDuty Malware Protection Resource Status" }], detail: { resourceStatus: [{ "anything-but": "ACTIVE" }] } },
    postScan: { source: ["aws.guardduty"], "detail-type": ["GuardDuty Malware Protection Post Scan Action Failed"] },
  });
});
