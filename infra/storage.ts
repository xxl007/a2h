// Uploads bucket (attachments, mail sink; voice notes later) and its file
// pipeline (m2-attachments design D2, D3, D9; ADR 0005).
// Key layout: `<area>/<STORAGE_PREFIX><key>` with area `tmp` or `uploads` and
// STORAGE_PREFIX `dev/`, `prod/` or `pr-<n>/`, so the lifecycle rules below
// (one per area root) cover every stage, including pr-* stages that share
// dev's bucket. Files live under `<area>/<STORAGE_PREFIX>files/`.
//
// Who owns what:
// - the bucket's owner (dev, prod) creates the bucket, its CORS, the
//   tag-based policy, S3 → EventBridge, the GuardDuty Malware Protection
//   plan on `tmp/` with its role, and the scanner alarms (account-level);
// - every stage (pr-* included) creates its own EventBridge rules and SQS
//   queue for its own `tmp/<prefix>files/` keys (createFileEvents);
// - no stage links the bucket: each service gets object grants under its own
//   prefix only (files.ts storagePermissions).
import { domain, STORAGE_AREAS, TMP_RETENTION_DAYS, UPLOAD_RETENTION_DAYS, type StageInfo, type StorageArea } from "./config.ts";
import {
  FILE_EVENT_QUEUE_POLICY_ACTIONS,
  fileEventPatterns,
  fileEventsQueueName,
  SCANNED_PREFIX,
  SCANNER_ROLE_LOGICAL_NAME,
  scanAlertPatterns,
  scannerRoleArn,
  scannerRolePolicy,
  scannerTrustPolicy,
  storagePermissions,
  uploadsBucketPolicy,
  uploadsCors,
  WORKER_QUEUE_ACTIONS,
  type ScopedPermission,
  type StorageService,
} from "./files.ts";

const RETENTION_DAYS: Record<StorageArea, number> = {
  uploads: UPLOAD_RETENTION_DAYS,
  tmp: TMP_RETENTION_DAYS,
};

/** Expiry rules, one per area root; pure (infra/test/storage.test.ts). */
export function lifecycleRules() {
  return STORAGE_AREAS.map((area) => ({
    id: `${area}-expiry`,
    prefix: `${area}/`,
    expiresIn: `${RETENTION_DAYS[area]} days` as const,
  }));
}

/**
 * dev and prod: the bucket and everything account-level about it. The
 * bucket policy names the scanner role by its ARN, computed (not read from
 * the role) because SST's Bucket exposes its name only after its policy exists.
 */
export function createUploads(stage: StageInfo) {
  const accountId = aws.getCallerIdentityOutput().accountId;
  const scanner = accountId.apply((id) => scannerRoleArn(stage, id));
  const bucket = new sst.aws.Bucket("Uploads", {
    enforceHttps: true,
    // POST (presigned upload) from the stage's web origin(s) only (D2).
    cors: uploadsCors(stage, domain),
    lifecycle: lifecycleRules(),
    policy: $util.all([scanner, accountId]).apply(([scannerRoleArn, id]) => uploadsBucketPolicy({ scannerRoleArn, accountId: id })),
  });

  // S3 → EventBridge, for the Object Created events the stages' rules route (ADR 0005 item 4).
  new aws.s3.BucketNotification("UploadsEventBridge", { bucket: bucket.name, eventbridge: true });

  // The scanner (ADR 0005 items 1 to 3): its role, then the plan on tmp/ with tagging.
  const role = new aws.iam.Role(SCANNER_ROLE_LOGICAL_NAME, {
    assumeRolePolicy: JSON.stringify(scannerTrustPolicy()),
    inlinePolicies: [{ name: "scan", policy: $util.all([bucket.name, accountId]).apply(([name, id]) => JSON.stringify(scannerRolePolicy(name, id))) }],
  });
  new aws.guardduty.MalwareProtectionPlan(
    "UploadsScan",
    {
      role: role.arn,
      protectedResource: { s3Bucket: { bucketName: bucket.name, objectPrefixes: [SCANNED_PREFIX] } },
      actions: [{ taggings: [{ status: "ENABLED" }] }],
    },
    { dependsOn: [role] },
  );

  createScanAlarms(stage);
  return bucket;
}

/**
 * ADR 0005 item 8: a plan status other than ACTIVE, or a post-scan action
 * failure, lands in an alert queue; an alarm fires while it holds a message.
 * Files keep being refused as not checked meanwhile: a broken scanner blocks
 * Send, it never lets a file through. The runbook says what to do.
 */
function createScanAlarms(stage: StageInfo) {
  const queue = new aws.sqs.Queue("ScanAlerts", { name: `a2h-${stage.name}-scan-alerts`, messageRetentionSeconds: 14 * 24 * 3600 });
  const patterns = scanAlertPatterns();
  const rules = (Object.keys(patterns) as (keyof typeof patterns)[]).map((key) => {
    const rule = new aws.cloudwatch.EventRule(`ScanAlert${key}`, { name: `a2h-${stage.name}-scan-alert-${key.toLowerCase()}`, eventPattern: JSON.stringify(patterns[key]) });
    new aws.cloudwatch.EventTarget(`ScanAlert${key}Target`, { rule: rule.name, arn: queue.arn });
    return rule;
  });
  queuePolicy("ScanAlertsPolicy", queue, rules);
  new aws.cloudwatch.MetricAlarm("ScanAlertsAlarm", {
    name: `a2h-${stage.name}-malware-scanner-attention`,
    alarmDescription: "GuardDuty Malware Protection for the uploads bucket reported a status other than ACTIVE or a failed post-scan tag. Files are refused as not checked until it is fixed. Read the messages in the a2h-<stage>-scan-alerts queue; see docs/decisions/0005-malware-scanning-of-uploads.md item 8.",
    namespace: "AWS/SQS",
    metricName: "ApproximateNumberOfMessagesVisible",
    dimensions: { QueueName: queue.name },
    statistic: "Maximum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 1,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    treatMissingData: "notBreaching",
  });
}

/** EventBridge may send to `queue`, only from `rules`. */
function queuePolicy(name: string, queue: aws.sqs.Queue, rules: aws.cloudwatch.EventRule[]) {
  return new aws.sqs.QueuePolicy(name, {
    queueUrl: queue.url,
    policy: $util.all([queue.arn, ...rules.map((r) => r.arn)]).apply(([queueArn, ...ruleArns]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "EventBridgeFromTheStageRules",
            Effect: "Allow",
            Principal: { Service: "events.amazonaws.com" },
            Action: FILE_EVENT_QUEUE_POLICY_ACTIONS,
            Resource: queueArn,
            Condition: { ArnEquals: { "aws:SourceArn": ruleArns } },
          },
        ],
      }),
    ),
  });
}

/** The stage's file-events queue, read by its worker (FILE_EVENTS_QUEUE_URL). */
export interface FileEvents {
  url: $util.Output<string>;
  arn: $util.Output<string>;
}

/**
 * Every stage: its two rules on the default bus (Object Created and scan
 * results under its own `tmp/<prefix>files/`) into its own queue (ADR 0005
 * item 4). A preview never sees dev's or another preview's files; the
 * scanner's validation object and the mail sink match no rule.
 */
export function createFileEvents(stage: StageInfo, bucketName: $util.Input<string>): FileEvents {
  const suffix = stage.componentSuffix;
  const queue = new aws.sqs.Queue(`FileEvents${suffix}`, {
    name: fileEventsQueueName(stage),
    // Longer than the worker's visibility timeout (60 s) times a few retries; results older than the 10-minute limit are moot.
    messageRetentionSeconds: 24 * 3600,
    visibilityTimeoutSeconds: 60,
    receiveWaitTimeSeconds: 20,
  });
  const patterns = $util.output(bucketName).apply((name) => fileEventPatterns(name, stage));
  const rules = (["created", "scanned"] as const).map((key) => {
    const rule = new aws.cloudwatch.EventRule(`File${key === "created" ? "Created" : "Scanned"}${suffix}`, {
      name: `a2h-${stage.name}-file-${key}`,
      eventPattern: patterns.apply((p) => JSON.stringify(p[key])),
    });
    new aws.cloudwatch.EventTarget(`File${key === "created" ? "Created" : "Scanned"}Target${suffix}`, { rule: rule.name, arn: queue.arn });
    return rule;
  });
  queuePolicy(`FileEventsPolicy${suffix}`, queue, rules);
  if (stage.ownsSharedResources) {
    // The worker stopped consuming: results pile up and every file times out as not checked.
    new aws.cloudwatch.MetricAlarm("FileEventsBacklogAlarm", {
      name: `a2h-${stage.name}-file-events-backlog`,
      alarmDescription: "The worker has not consumed file events for 5 minutes: uploads will be refused as not checked.",
      namespace: "AWS/SQS",
      metricName: "ApproximateAgeOfOldestMessage",
      dimensions: { QueueName: queue.name },
      statistic: "Maximum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 300,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      treatMissingData: "notBreaching",
    });
  }
  return { url: queue.url, arn: queue.arn };
}

/** How a stage's services reach the bucket: its name; grants are per service and prefix (files.ts). */
export interface StorageGrant {
  bucketName: $util.Input<string>;
}

/**
 * Component arguments for a service: its object grants under its own prefix
 * (and, for the worker, receive and delete on its file-events queue) and the
 * environment it reads. Every service gets UPLOADS_BUCKET; the worker also
 * FILE_EVENTS_QUEUE_URL. No service links the bucket.
 */
export function storageArgs(grant: StorageGrant, stage: StageInfo, service: StorageService, events?: FileEvents) {
  const permissions = $util.all([grant.bucketName, events ? events.arn : ""]).apply(([name, queueArn]): ScopedPermission[] => [
    ...storagePermissions(service, stage, name),
    ...(service === "worker" && queueArn ? [{ actions: [...WORKER_QUEUE_ACTIONS], resources: [queueArn] }] : []),
  ]);
  return {
    permissions,
    environment: {
      UPLOADS_BUCKET: grant.bucketName,
      ...(service === "worker" && events ? { FILE_EVENTS_QUEUE_URL: events.url } : {}),
    },
  };
}
