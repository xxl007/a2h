// SES delivery, production only. This is the one module in packages/email
// that imports an AWS SDK: it is the email counterpart of `apps/*/infra`
// (CLAUDE.md: AWS SDKs only inside apps/*/infra and infra/). The client is
// injected, so the caller constructs `new SESv2Client(...)` and only on prod
// (see `mailerFor` in ./factory.ts). The sending identity and the
// configuration set are created by infra, not here.
import { SendEmailCommand, type SendEmailCommandOutput } from "@aws-sdk/client-sesv2";
import type { Mailer, Message } from "./mailer.ts";

/** The part of SESv2Client this mailer uses. A real SESv2Client satisfies it. */
export interface SesSendClient {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>;
}

export interface SesMailerOptions {
  client: SesSendClient;
  /** Verified sender, from stage configuration, e.g. `A2H <no-reply@…>`. */
  from: string;
  /** SES configuration set (event publishing, suppression), if any. */
  configurationSetName?: string | undefined;
}

export class SesMailer implements Mailer {
  readonly #client: SesSendClient;
  readonly #from: string;
  readonly #configurationSetName: string | undefined;

  constructor(options: SesMailerOptions) {
    if (!options.from) throw new TypeError("SesMailer needs a sender address.");
    this.#client = options.client;
    this.#from = options.from;
    this.#configurationSetName = options.configurationSetName;
  }

  async send(message: Message): Promise<{ id: string }> {
    const out = await this.#client.send(
      new SendEmailCommand({
        FromEmailAddress: this.#from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              Html: { Data: message.html, Charset: "UTF-8" },
            },
          },
        },
        ...(this.#configurationSetName ? { ConfigurationSetName: this.#configurationSetName } : {}),
      }),
    );
    if (!out.MessageId) throw new Error("SES returned no MessageId.");
    return { id: out.MessageId };
  }
}
