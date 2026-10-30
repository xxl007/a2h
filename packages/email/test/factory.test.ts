// Task 6.1, spec "Preview sign-in", design D6: SES on prod only; the sink on
// every other stage, and the SES client factory is never called off prod.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailerFor, type MailerDeps } from "../src/factory.ts";
import { SesMailer } from "../src/ses.ts";
import { S3SinkMailer } from "../src/sink.ts";

function deps() {
  const calls = { ses: 0, s3: 0 };
  const d: MailerDeps = {
    sesClient: () => {
      calls.ses++;
      return { send: () => Promise.resolve({ MessageId: "m", $metadata: {} }) };
    },
    objectClient: () => {
      calls.s3++;
      return { putObject: () => Promise.resolve() };
    },
    from: "no-reply@a2h-protocol.org",
    bucket: "a2h-dev-uploads",
    storagePrefix: "dev/",
  };
  return { d, calls };
}

for (const stage of ["dev", "pr-12", "pr-48899"]) {
  test(`${stage}: the sink, and the SES client factory is never called`, async () => {
    const { d, calls } = deps();
    const mailer = mailerFor(stage, d);
    assert.ok(mailer instanceof S3SinkMailer);
    await mailer.send({ to: "a@example.com", subject: "s", text: "t", html: "h" });
    assert.equal(calls.ses, 0);
    assert.equal(calls.s3, 1);
  });
}

test("prod: SES, and the object client factory is never called", () => {
  const { d, calls } = deps();
  const mailer = mailerFor("prod", d);
  assert.ok(mailer instanceof SesMailer);
  assert.equal(calls.ses, 1);
  assert.equal(calls.s3, 0);
});

test("an unknown stage name is refused, not defaulted", () => {
  const { d, calls } = deps();
  for (const stage of ["", "production", "Prod", "pr-", "pr-x", "staging"]) {
    assert.throws(() => mailerFor(stage, d), /stage/);
  }
  assert.equal(calls.ses + calls.s3, 0);
});
