// Stage selection (spec principal-identity "Magic links leave production
// only through email", scenario "Preview sign-in"; design D6). Clients are
// passed as factories so that the SES client is constructed on prod only and
// the object client everywhere else, never both.
import type { Mailer } from "./mailer.ts";
import { SesMailer, type SesSendClient } from "./ses.ts";
import { S3SinkMailer, type ObjectPutClient } from "./sink.ts";
import { assertStage } from "./stage.ts";

export interface MailerDeps {
  /** Called on prod only. */
  sesClient: () => SesSendClient;
  /** Called on every stage but prod. */
  objectClient: () => ObjectPutClient;
  /** SES sender (prod). */
  from: string;
  /** SES configuration set (prod), optional. */
  configurationSetName?: string | undefined;
  /** Uploads bucket (`UPLOADS_BUCKET`) for the sink. */
  bucket: string;
  /** Stage storage prefix (`STORAGE_PREFIX`: `dev/`, `pr-<n>/`) for the sink. */
  storagePrefix: string;
}

export function mailerFor(stage: string, deps: MailerDeps): Mailer {
  assertStage(stage);
  if (stage === "prod") {
    return new SesMailer({
      client: deps.sesClient(),
      from: deps.from,
      configurationSetName: deps.configurationSetName,
    });
  }
  return new S3SinkMailer({ client: deps.objectClient(), bucket: deps.bucket, prefix: deps.storagePrefix });
}
