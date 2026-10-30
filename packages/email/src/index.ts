// Provider-neutral core: the Mailer interface, stage labels and templates.
// No AWS import here or in anything this file imports (eslint.config.mjs);
// providers live in `@a2h/email/ses` and `@a2h/email/sink`.
export type { Mailer, Message } from "./mailer.ts";
export { stageLabel } from "./stage.ts";
export {
  MAGIC_LINK_MAX_MINUTES,
  renderMagicLink,
  type MagicLinkInput,
  type RenderedEmail,
} from "./magic-link.ts";
