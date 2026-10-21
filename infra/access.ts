// Who a stage's containers log in as and what they may touch in storage.
// Pure: no SST globals, no I/O, unit-tested in infra/test/access.test.ts.
// Contract: openspec/changes/m0-foundation/tasks.md, contract amendment 1
// ("Per-PR database login", "Scoped storage on previews").
import { STORAGE_AREAS, type StageInfo } from "./config.ts";

/** JSON key of the password in both the Aurora master secret and `a2h/pr-<n>/db`. */
export const DB_PASSWORD_KEY = "password";

function prNumber(stage: StageInfo): number {
  if (stage.kind !== "pr" || stage.prNumber === undefined) {
    throw new Error(`Stage "${stage.name}" is not a pr-<n> stage.`);
  }
  return stage.prNumber;
}

/** Login role of a preview: `pr_<n>`, owner of schema `pr_<n>` (pr-schema.sh). */
export function prDbUser(stage: StageInfo): string {
  return `pr_${prNumber(stage)}`;
}

/** Secrets Manager secret created by `pr-schema.sh create <n>` before `sst deploy`. */
export function prDbSecretName(stage: StageInfo): string {
  return `a2h/pr-${prNumber(stage)}/db`;
}

const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

/**
 * ECS `secrets[].valueFrom` for one JSON key of a Secrets Manager secret:
 * `<secretArn>:<jsonKey>::` (empty version stage and version id = AWSCURRENT).
 */
export function secretValueFrom(secretArn: string, jsonKey: string): string {
  if (!SECRET_ARN.test(secretArn)) {
    throw new Error(`Not a Secrets Manager secret ARN: "${secretArn}".`);
  }
  return `${secretArn}:${jsonKey}::`;
}

export type DbCredentialSource =
  /** dev and prod (M0): the Aurora master user and its SST-managed secret. */
  | { kind: "master"; username: string; secretArn: string }
  /** pr-<n>: the per-PR login; the ARN of `a2h/pr-<n>/db`, looked up at deploy time. */
  | { kind: "pr-login"; secretArn: string };

export interface DbCredentials {
  /** Plain task environment. Never holds the password. */
  environment: { DB_USER: string };
  /** ECS-injected secrets (Service `ssm`): name -> valueFrom. */
  ssm: { DB_PASSWORD: string };
}

export function dbCredentials(stage: StageInfo, source: DbCredentialSource): DbCredentials {
  if (stage.kind === "pr") {
    if (source.kind !== "pr-login") {
      throw new Error(`Stage "${stage.name}" must never use the Aurora master credentials.`);
    }
    // Secrets Manager appends "-" and six random characters to the name.
    const name = prDbSecretName(stage);
    if (!source.secretArn.includes(`:secret:${name}-`)) {
      throw new Error(`Stage "${stage.name}" must read its password from ${name}, got "${source.secretArn}".`);
    }
    return {
      environment: { DB_USER: prDbUser(stage) },
      ssm: { DB_PASSWORD: secretValueFrom(source.secretArn, DB_PASSWORD_KEY) },
    };
  }
  if (source.kind !== "master") {
    throw new Error(`Stage "${stage.name}" uses the master user in M0, not a pr login.`);
  }
  return {
    environment: { DB_USER: source.username },
    ssm: { DB_PASSWORD: secretValueFrom(source.secretArn, DB_PASSWORD_KEY) },
  };
}

export interface PermissionStatement {
  actions: string[];
  resources: string[];
}

export type StorageAccess =
  /** dev and prod: SST `link` to the uploads bucket. */
  | { mode: "link" }
  /** pr-<n>: object access under the stage's prefix only, no link. */
  | {
      mode: "scoped";
      permissions: PermissionStatement[];
      environment: { UPLOADS_BUCKET: string };
    };

export const PREVIEW_OBJECT_ACTIONS = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"];

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Storage grant for a stage. pr-* needs the shared bucket's name (a plain
 * string read from SSM at deploy time) to build the object ARNs.
 */
export function storageAccess(stage: StageInfo, bucketName?: string): StorageAccess {
  if (stage.kind !== "pr") return { mode: "link" };
  if (!bucketName || !BUCKET_NAME.test(bucketName)) {
    throw new Error(`Stage "${stage.name}" needs a valid uploads bucket name, got "${bucketName}".`);
  }
  return {
    mode: "scoped",
    permissions: [
      {
        actions: [...PREVIEW_OBJECT_ACTIONS],
        resources: STORAGE_AREAS.map(
          (area) => `arn:aws:s3:::${bucketName}/${area}/${stage.storagePrefix}*`,
        ),
      },
    ],
    environment: { UPLOADS_BUCKET: bucketName },
  };
}
