// Stage selection (spec principal-identity "Magic links leave production
// only through email", scenario "Preview sign-in"; design D6). Both sides are
// passed as factories so that the production mailer (SES, built in
// apps/web/infra) is constructed on prod only and the object client
// everywhere else, never both. Nothing here imports an AWS SDK.
import type { Mailer } from "./mailer.ts";
import { S3SinkMailer, type ObjectPutClient } from "./sink.ts";
import { assertStage } from "./stage.ts";

export interface MailerDeps {
  /** Called on prod only: the mailer that sends real email (SES, apps/web/infra/ses-mailer.ts). */
  prodMailer: () => Mailer;
  /** Called on every stage but prod. */
  objectClient: () => ObjectPutClient;
  /** Uploads bucket (`UPLOADS_BUCKET`) for the sink. */
  bucket: string;
  /** Stage storage prefix (`STORAGE_PREFIX`: `dev/`, `pr-<n>/`) for the sink. */
  storagePrefix: string;
}

export function mailerFor(stage: string, deps: MailerDeps): Mailer {
  assertStage(stage);
  if (stage === "prod") return deps.prodMailer();
  return new S3SinkMailer({ client: deps.objectClient(), bucket: deps.bucket, prefix: deps.storagePrefix });
}
