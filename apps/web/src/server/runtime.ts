// Composition root of the web app's server side: configuration, database,
// allow-list, mailer and the authorization server, built once per Lambda
// instance (cold start) and shared by every route, page and server action.
// The AWS-specific parts come from apps/web/infra; nothing here imports an
// AWS SDK. A failed build is not cached, so the next request retries.
import { renderMagicLink, stageLabel } from "@a2h/email";
import { allowlistLoader } from "../../infra/allowlist";
import { checkSchema, databaseFromEnv } from "../../infra/db";
import { createMailer } from "../../infra/mail";
import type { PrincipalsDb } from "@a2h/db";
import { Allowlist } from "../auth/allowlist";
import { createAuth, MAGIC_LINK_MINUTES, type Auth } from "../auth/auth";
import { syncPreRegisteredClients } from "../auth/clients";
import { webConfigFromEnv, type WebConfig } from "../config";
import { createLogger, type Logger } from "../log";

export interface Runtime {
  config: WebConfig;
  db: PrincipalsDb;
  auth: Auth;
  /** A Better Auth instance on another database handle (a transaction: consent, D4). */
  authOn: (db: PrincipalsDb) => Auth;
  isAllowed: (email: string) => Promise<boolean>;
  logger: Logger;
}

let pending: Promise<Runtime> | undefined;

export function getRuntime(): Promise<Runtime> {
  pending ??= build().catch((e: unknown) => {
    pending = undefined;
    throw e;
  });
  return pending;
}

async function build(): Promise<Runtime> {
  const config = webConfigFromEnv(process.env);
  const logger = createLogger({ base: { stage: config.stage } });
  const { db, schema } = await databaseFromEnv(process.env);
  await checkSchema(db, schema);
  const allowlist = new Allowlist(allowlistLoader(config.allowlist), { logger });
  const isAllowed = (email: string) => allowlist.has(email);
  const mailer = createMailer({ ...config, localDir: process.env["LOCAL_MAIL_DIR"] });
  const label = stageLabel(config.stage);

  const sendMagicLink = async (email: string, url: string) => {
    const rendered = await renderMagicLink({ link: url, expiresInMinutes: MAGIC_LINK_MINUTES, productName: "A2H", stage: label });
    const { id } = await mailer.send({ to: email, ...rendered });
    logger.info("magic link sent", { code: "magic_link_sent", request_id: id });
  };
  const authOn = (database: PrincipalsDb) =>
    createAuth({ db: database, config, sendMagicLink, isAllowed, logger });
  const auth = authOn(db);
  await syncPreRegisteredClients(db, auth, config.clients, config.mcpUrl);
  return { config, db, auth, authOn, isAllowed, logger };
}
