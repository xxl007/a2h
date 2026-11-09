// Files attached on the approval page (m2-attachments design D2, D3, D5, D6,
// D9; ADR 0005): the uploads bucket's CORS, who may touch which key, the
// tag-based bucket policy, the scanner's role, the per-stage event routing
// and the alarms. Pure: no SST globals, no I/O; unit-tested in
// infra/test/files.test.ts. The SST wiring is infra/storage.ts.
//
// Key layout: `<area>/<STORAGE_PREFIX>files/<request_id>/<file_id>`
// (packages/protocol fileObjectKey). `tmp/` holds uploads until they are
// checked and scanned; `uploads/` holds the clean copies.
import { assertAccountId, hostnames, REGION, roleName, type StageInfo } from "./config.ts";

/** The tag GuardDuty sets on a scanned object, and its clean value (ADR 0005 items 3, 7). */
export const SCAN_TAG = "GuardDutyMalwareScanStatus";
export const SCAN_TAG_CLEAN = "NO_THREATS_FOUND";

/** The one prefix the Malware Protection plan scans (ADR 0005 item 2): literal, every stage's tmp/. */
export const SCANNED_PREFIX = "tmp/";

/** Logical name of the scanner's IAM role; its physical name is roleName(stage, this). */
export const SCANNER_ROLE_LOGICAL_NAME = "UploadsScanRole";

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const VALIDATION_OBJECT = "malware-protection-resource-validation-object";
const MANAGED_RULE = "DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*";
const PLAN_SERVICE = "malware-protection-plan.guardduty.amazonaws.com";

function checkBucket(bucket: string): string {
  if (!BUCKET_NAME.test(bucket)) throw new Error(`Not a valid uploads bucket name: "${bucket}".`);
  return bucket;
}

function owner(stage: StageInfo): void {
  if (!stage.ownsSharedResources) throw new Error(`Stage "${stage.name}" does not own the uploads bucket; its owner (dev or prod) configures it.`);
}

// ---- CORS (D2) -----------------------------------------------------------------

export interface UploadsCors {
  allowMethods: ["POST"];
  allowOrigins: string[];
  allowHeaders: string[];
  maxAge: `${number} hour`;
}

/**
 * The bucket's CORS, set by its owner: POST (the presigned upload) from the
 * owner's web origin and, on dev, from its previews' origins
 * (`pr-<n>.dev.<domain>`, which share dev's bucket). Downloads are presigned
 * GETs opened by navigation, which need no CORS. Without a domain no web
 * origin is known: no CORS (browser uploads fail) rather than `*`.
 */
export function uploadsCors(stage: StageInfo, domain: string | undefined): UploadsCors | false {
  owner(stage);
  if (!domain) return false;
  const origins = [`https://${hostnames(stage, domain).web}`];
  if (stage.kind === "dev") origins.push(`https://pr-*.dev.${domain}`);
  return { allowMethods: ["POST"], allowOrigins: origins, allowHeaders: ["*"], maxAge: "1 hour" };
}

// ---- grants (D2, D3, D5, D6; ADR 0005 item 7) ----------------------------------

export interface PermissionCondition {
  test: string;
  variable: string;
  values: string[];
}

export interface ScopedPermission {
  actions: string[];
  resources: string[];
  conditions?: PermissionCondition[];
}

export type StorageService = "web" | "mcp" | "worker";

/**
 * What a stage's service may do in the uploads bucket, under its own prefix
 * only (every stage, dev and prod included: no bucket-wide link).
 * - web: write uploads into `tmp/<p>files/` (presigned POST, D2); read
 *   `uploads/<p>files/` only when the object carries the clean tag (presigned
 *   GET, D6); delete either area (removal, D5); write the mail sink
 *   `tmp/<p>mail/`. Never read `tmp/`.
 * - worker: read, write, delete and copy with tags in both files areas (D3, D5).
 * - mcp: nothing (agents never read files, D8).
 */
export function storagePermissions(service: StorageService, stage: StageInfo, bucket: string): ScopedPermission[] {
  const arn = (key: string) => `arn:aws:s3:::${checkBucket(bucket)}/${key}`;
  const p = stage.storagePrefix;
  const tmpFiles = arn(`tmp/${p}files/*`);
  const uploadFiles = arn(`uploads/${p}files/*`);
  if (service === "web") {
    return [
      { actions: ["s3:PutObject"], resources: [tmpFiles] },
      { actions: ["s3:GetObject"], resources: [uploadFiles], conditions: [{ test: "StringEquals", variable: `s3:ExistingObjectTag/${SCAN_TAG}`, values: [SCAN_TAG_CLEAN] }] },
      { actions: ["s3:DeleteObject"], resources: [tmpFiles, uploadFiles] },
      { actions: ["s3:PutObject"], resources: [arn(`tmp/${p}mail/*`)] },
    ];
  }
  if (service === "worker") {
    return [{ actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectTagging", "s3:PutObjectTagging"], resources: [tmpFiles, uploadFiles] }];
  }
  return [];
}

// ---- the scanner's role (ADR 0005 item 1) ---------------------------------------

export interface RolePolicyDocument {
  Version: "2012-10-17";
  Statement: { Sid: string; Effect: "Allow"; Action: string[]; Resource: string[]; Condition?: Record<string, Record<string, string>> }[];
}

export function scannerTrustPolicy() {
  return {
    Version: "2012-10-17" as const,
    Statement: [{ Effect: "Allow" as const, Principal: { Service: PLAN_SERVICE }, Action: "sts:AssumeRole" as const }],
  };
}

/** The scanner role's ARN, known before the role exists (roleName is deterministic; sst.config.ts applies it). */
export function scannerRoleArn(stage: StageInfo, accountId: string): string {
  owner(stage);
  return `arn:aws:iam::${assertAccountId(accountId)}:role/${roleName(stage.name, SCANNER_ROLE_LOGICAL_NAME)}`;
}

/**
 * The GuardDuty guide's role policy template ("Create or update IAM role
 * policy"), scoped: objects under tmp/ and the validation object only, this
 * bucket only, the managed rule only. No KMS statement: the bucket is SSE-S3.
 */
export function scannerRolePolicy(bucket: string, accountId: string): RolePolicyDocument {
  const b = `arn:aws:s3:::${checkBucket(bucket)}`;
  const rule = `arn:aws:events:${REGION}:${assertAccountId(accountId)}:rule/${MANAGED_RULE}`;
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "ManagedRule", Effect: "Allow", Action: ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"], Resource: [rule], Condition: { StringLike: { "events:ManagedBy": PLAN_SERVICE } } },
      { Sid: "ManagedRuleRead", Effect: "Allow", Action: ["events:DescribeRule", "events:ListTargetsByRule"], Resource: [rule] },
      { Sid: "Tag", Effect: "Allow", Action: ["s3:PutObjectTagging", "s3:GetObjectTagging", "s3:PutObjectVersionTagging", "s3:GetObjectVersionTagging"], Resource: [`${b}/${SCANNED_PREFIX}*`] },
      { Sid: "BucketNotification", Effect: "Allow", Action: ["s3:PutBucketNotification", "s3:GetBucketNotification"], Resource: [b] },
      { Sid: "ValidationObject", Effect: "Allow", Action: ["s3:PutObject"], Resource: [`${b}/${VALIDATION_OBJECT}`] },
      { Sid: "BucketOwnership", Effect: "Allow", Action: ["s3:ListBucket"], Resource: [b] },
      { Sid: "Scan", Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion"], Resource: [`${b}/${SCANNED_PREFIX}*`, `${b}/${VALIDATION_OBJECT}`] },
    ],
  };
}

// ---- the bucket policy (ADR 0005 item 7) ---------------------------------------

/** Every stage's worker task role (`a2h-<stage>-Worker[Pr<n>]TaskRole-<hash>`, roleName()). */
export function workerRoleArnPattern(accountId: string): string {
  return `arn:aws:iam::${assertAccountId(accountId)}:role/a2h-*-Worker*TaskRole-*`;
}

export interface BucketPolicyStatement {
  effect: "deny";
  principals: "*";
  actions: string[];
  /** Relative to the bucket ARN (SST Bucket `policy`). */
  paths: string[];
  conditions: PermissionCondition[];
}

/**
 * Statements added to the uploads bucket's policy by its owner:
 * 1. Nobody but the scanner and the workers reads an uploaded file in tmp/
 *    unless GuardDuty tagged it clean. Scoped to `tmp/*\/files/*`, the files
 *    of every stage: the mail sink (`tmp/<p>mail/`) is not a file and is read
 *    by the e2e suites with the deploy roles. Exceptions by `aws:PrincipalArn`
 *    (ArnNotLike), not NotPrincipal: ECS task session names are unpredictable.
 * 2. Nobody but the scanner sets the scan tag in tmp/, by PutObject or by tagging.
 * The web role's read of uploads/ needs the clean tag in its own grant
 * (storagePermissions); the worker's copy carries the tag over.
 */
export function uploadsBucketPolicy({ scannerRoleArn: scanner, accountId }: { scannerRoleArn: string; accountId: string }): BucketPolicyStatement[] {
  return [
    {
      effect: "deny",
      principals: "*",
      actions: ["s3:GetObject", "s3:GetObjectVersion"],
      paths: [`${SCANNED_PREFIX}*/files/*`],
      conditions: [
        { test: "StringNotEquals", variable: `s3:ExistingObjectTag/${SCAN_TAG}`, values: [SCAN_TAG_CLEAN] },
        { test: "ArnNotLike", variable: "aws:PrincipalArn", values: [scanner, workerRoleArnPattern(accountId)] },
      ],
    },
    {
      effect: "deny",
      principals: "*",
      actions: ["s3:PutObject", "s3:PutObjectTagging", "s3:PutObjectVersionTagging"],
      paths: [`${SCANNED_PREFIX}*`],
      conditions: [
        { test: "ForAnyValue:StringEquals", variable: "s3:RequestObjectTagKeys", values: [SCAN_TAG] },
        { test: "ArnNotLike", variable: "aws:PrincipalArn", values: [scanner] },
      ],
    },
  ];
}

// ---- event routing (ADR 0005 item 4) -------------------------------------------

/**
 * The stage's two EventBridge rules on the default bus: S3 "Object Created"
 * and GuardDuty scan results whose key starts with the stage's
 * `tmp/<prefix>files/` (the trailing slash keeps pr-1 from matching pr-12).
 */
export function fileEventPatterns(bucket: string, stage: StageInfo) {
  const prefix = `${SCANNED_PREFIX}${stage.storagePrefix}files/`;
  checkBucket(bucket);
  return {
    created: {
      source: ["aws.s3"],
      "detail-type": ["Object Created"],
      detail: { bucket: { name: [bucket] }, object: { key: [{ prefix }] } },
    },
    scanned: {
      source: ["aws.guardduty"],
      "detail-type": ["GuardDuty Malware Protection Object Scan Result"],
      detail: { s3ObjectDetails: { bucketName: [bucket], objectKey: [{ prefix }] } },
    },
  };
}

/** The stage's file-events queue. `a2h-` first: the workload boundary allows SQS on `a2h-*` only. */
export function fileEventsQueueName(stage: StageInfo): string {
  return `a2h-${stage.name}-file-events`;
}

/** What EventBridge may do on the queue (with aws:SourceArn = the stage's rules). */
export const FILE_EVENT_QUEUE_POLICY_ACTIONS = ["sqs:SendMessage"];
/** What the worker's task role may do on its queue. */
export const WORKER_QUEUE_ACTIONS = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"];

// ---- alarms (ADR 0005 item 8) --------------------------------------------------

/** Events that mean scanning is broken or a clean tag may be missing; routed to an alert queue with an alarm on it. */
export function scanAlertPatterns() {
  return {
    status: { source: ["aws.guardduty"], "detail-type": [{ prefix: "GuardDuty Malware Protection Resource Status" }], detail: { resourceStatus: [{ "anything-but": "ACTIVE" }] } },
    postScan: { source: ["aws.guardduty"], "detail-type": ["GuardDuty Malware Protection Post Scan Action Failed"] },
  };
}
