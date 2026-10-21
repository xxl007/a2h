// Uploads bucket (voice notes, attachments; presigned uploads come later).
// Key layout: `<area>/<STORAGE_PREFIX><key>` with area `tmp` or `uploads` and
// STORAGE_PREFIX `dev/`, `prod/` or `pr-<n>/`, so the lifecycle rules below
// (one per area root) cover every stage, including pr-* stages that share
// dev's bucket. pr-* stages do not link the bucket: they get object access
// under their own prefix only (access.ts).
import {
  STORAGE_AREAS,
  TMP_RETENTION_DAYS,
  UPLOAD_RETENTION_DAYS,
  type StorageArea,
} from "./config.ts";
import type { PermissionStatement, StorageAccess } from "./access.ts";

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

export function createUploads() {
  return new sst.aws.Bucket("Uploads", {
    enforceHttps: true,
    // Browsers upload with presigned PUT and read with presigned GET.
    // Origins are narrowed to the web domain once one exists.
    cors: {
      allowMethods: ["GET", "PUT"],
      allowOrigins: ["*"],
      allowHeaders: ["*"],
    },
    lifecycle: lifecycleRules(),
  });
}

/**
 * How a stage's services and Web reach the bucket: dev and prod `link` it,
 * pr-* get the scoped grant from access.ts (no link).
 */
export type StorageGrant =
  | { mode: "link"; bucket: sst.aws.Bucket }
  | Extract<StorageAccess, { mode: "scoped" }>;

/** Component arguments for a grant. Every stage gets env UPLOADS_BUCKET. */
export function storageArgs(grant: StorageGrant) {
  if (grant.mode === "link") {
    return {
      link: [grant.bucket],
      permissions: [] as PermissionStatement[],
      environment: { UPLOADS_BUCKET: grant.bucket.name as $util.Input<string> },
    };
  }
  return {
    link: [] as sst.aws.Bucket[],
    permissions: grant.permissions,
    environment: { UPLOADS_BUCKET: grant.environment.UPLOADS_BUCKET as $util.Input<string> },
  };
}
