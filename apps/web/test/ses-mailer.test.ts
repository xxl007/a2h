// Task 6.1: the SES mailer sends one SendEmail with the configured sender,
// the recipient, the subject, both bodies and the configuration set. Moved
// from packages/email with the mailer (task 10.5: AWS SDKs only inside
// apps/*/infra and infra/).
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { describe, expect, test } from "vitest";
import { SesMailer, type SesSendClient } from "../infra/ses-mailer";

function mockClient(messageId = "0102-ses-id") {
  const sent: SendEmailCommand[] = [];
  const client: SesSendClient = {
    send(command) {
      sent.push(command);
      return Promise.resolve({ MessageId: messageId, $metadata: {} });
    },
  };
  return { client, sent };
}

const message = { to: "owner@example.com", subject: "Your A2H sign-in link", text: "text body", html: "<p>html body</p>" };

describe("SesMailer", () => {
test("send carries sender, recipient, subject, both bodies and the configuration set", async () => {
  const { client, sent } = mockClient();
  const mailer = new SesMailer({ client, from: "A2H <no-reply@a2h-protocol.org>", configurationSetName: "a2h-prod" });
  const result = await mailer.send(message);
  expect(sent).toHaveLength(1);
  const cmd = sent[0];
  expect(cmd).toBeInstanceOf(SendEmailCommand);
  expect(cmd!.input).toEqual({
    FromEmailAddress: "A2H <no-reply@a2h-protocol.org>",
    Destination: { ToAddresses: ["owner@example.com"] },
    Content: {
      Simple: {
        Subject: { Data: "Your A2H sign-in link", Charset: "UTF-8" },
        Body: {
          Text: { Data: "text body", Charset: "UTF-8" },
          Html: { Data: "<p>html body</p>", Charset: "UTF-8" },
        },
      },
    },
    ConfigurationSetName: "a2h-prod",
  });
  expect(result).toEqual({ id: "0102-ses-id" });
});

test("no configuration set is sent when none is configured", async () => {
  const { client, sent } = mockClient();
  await new SesMailer({ client, from: "no-reply@a2h-protocol.org" }).send(message);
  expect(sent[0]?.input).not.toHaveProperty("ConfigurationSetName");
});

test("a response without a message id is an error", async () => {
  const client: SesSendClient = { send: () => Promise.resolve({ $metadata: {} }) };
  await expect(new SesMailer({ client, from: "no-reply@a2h-protocol.org" }).send(message)).rejects.toThrow(/no MessageId/);
});

test("an empty sender is refused at construction", () => {
  const { client } = mockClient();
  expect(() => new SesMailer({ client, from: "" })).toThrow(TypeError);
});
});
