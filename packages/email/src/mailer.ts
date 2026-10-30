/**
 * One email, fully rendered. The caller renders a template, then hands the
 * message to a Mailer; the Mailer never sees template inputs.
 */
export interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Provider-neutral delivery. Implementations: SesMailer (`@a2h/email/ses`,
 * prod only) and S3SinkMailer (`@a2h/email/sink`, every other stage).
 * A Mailer logs nothing; it returns an opaque id the caller may log.
 */
export interface Mailer {
  send(message: Message): Promise<{ id: string }>;
}
