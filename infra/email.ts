// SES identity. Created by dev and prod only when config.emailSender is set;
// pr-* reuses dev's identity through Email.get when one was published.
import { domain, EMAIL_SENDER_NONE, emailSender } from "./config.ts";

export function createEmail(): sst.aws.Email | undefined {
  // No sender chosen yet (owner decision, runbook §9): skip the component.
  // dev then publishes EMAIL_SENDER_NONE so pr-* stages know to skip too.
  if (!emailSender) return undefined;
  return new sst.aws.Email("Email", {
    sender: emailSender,
    dns: domain ? sst.aws.dns() : false,
  });
}

export function getEmail(sender: string): sst.aws.Email | undefined {
  if (!sender || sender === EMAIL_SENDER_NONE) return undefined;
  return sst.aws.Email.get("Email", sender);
}
