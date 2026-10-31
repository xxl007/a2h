// Deployment adapter for email (design D6): `mailerFor(STAGE, …)` from
// @a2h/email: SES on prod only, the stage's mail sink everywhere else, under
// `tmp/<STORAGE_PREFIX>mail/<id>.json` in the uploads bucket (the 7-day `tmp`
// lifecycle rule expires it; a preview's `tmp/pr-<n>/*` grant covers it).
// LOCAL_MAIL_DIR (never set on a deployed stage, refused on prod) writes the
// same objects to a local directory, for a local server and its e2e tests.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import type { Mailer } from "@a2h/email";
import { mailerFor } from "@a2h/email/factory";
import type { ObjectPutClient } from "@a2h/email/sink";

export interface MailConfig {
  stage: string;
  emailFrom: string;
  uploadsBucket: string;
  /** `tmp/<STORAGE_PREFIX>`; the sink appends `mail/`. */
  mailSinkPrefix: string;
  /** Local directory instead of S3 (non-prod only). */
  localDir?: string | undefined;
}

export function localObjectClient(dir: string): ObjectPutClient {
  const root = resolve(dir);
  return {
    async putObject({ key, body }) {
      const path = resolve(join(root, key));
      if (!path.startsWith(root + sep)) throw new Error("object key escapes the local mail directory");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
  };
}

function s3ObjectClient(): ObjectPutClient {
  const s3 = new S3Client({});
  return {
    putObject: (a) => s3.send(new PutObjectCommand({ Bucket: a.bucket, Key: a.key, Body: a.body, ContentType: a.contentType })),
  };
}

export function createMailer(config: MailConfig): Mailer {
  if (config.localDir && config.stage === "prod") throw new Error("web mail configuration: LOCAL_MAIL_DIR is refused on prod");
  return mailerFor(config.stage, {
    sesClient: () => new SESv2Client({}),
    objectClient: () => (config.localDir ? localObjectClient(config.localDir) : s3ObjectClient()),
    from: config.emailFrom,
    bucket: config.uploadsBucket || "local",
    storagePrefix: config.mailSinkPrefix,
  });
}
