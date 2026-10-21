// Uploads bucket (voice notes, attachments; presigned uploads come later).
// Key layout: `<area>/<STORAGE_PREFIX><key>` with area `tmp` or `uploads`, so
// the lifecycle rules below also cover the objects of pr-* stages, which
// share dev's bucket with STORAGE_PREFIX `pr-<n>/`.
import { TMP_RETENTION_DAYS, UPLOAD_RETENTION_DAYS } from "./config.ts";

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
    lifecycle: [
      { id: "tmp-expiry", prefix: "tmp/", expiresIn: `${TMP_RETENTION_DAYS} days` },
      {
        id: "uploads-expiry",
        prefix: "uploads/",
        expiresIn: `${UPLOAD_RETENTION_DAYS} days`,
      },
    ],
  });
}

export function getUploads(bucketName: string) {
  return sst.aws.Bucket.get("Uploads", bucketName);
}
