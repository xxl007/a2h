// Provider-neutral core: the Mailer interface, stage labels and templates.
// No AWS import here or in anything this file imports (eslint.config.mjs);
// the stage sink is `@a2h/email/sink` (injected object client); the SES
// mailer is a deployment adapter in apps/web/infra (no AWS SDK in packages/).
export type { Mailer, Message } from "./mailer.ts";
export { stageLabel } from "./stage.ts";
export {
  MAGIC_LINK_MAX_MINUTES,
  renderMagicLink,
  type MagicLinkInput,
  type RenderedEmail,
} from "./magic-link.ts";
