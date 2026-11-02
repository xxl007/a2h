// Task 6.1, spec "Preview sign-in", design D6: the production mailer on prod
// only; the sink on every other stage, and the production mailer factory is
// never called off prod. The production mailer itself (SES) lives in
// apps/web/infra (task 10.5), so this package imports no AWS SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailerFor, type MailerDeps } from "../src/factory.ts";
import type { Mailer } from "../src/mailer.ts";
import { S3SinkMailer } from "../src/sink.ts";

const prod: Mailer = { send: () => Promise.resolve({ id: "m" }) };

function deps() {
  const calls = { ses: 0, s3: 0 };
  const d: MailerDeps = {
    prodMailer: () => {
      calls.ses++;
      return prod;
    },
    objectClient: () => {
      calls.s3++;
      return { putObject: () => Promise.resolve() };
    },
    bucket: "a2h-dev-uploads",
    storagePrefix: "dev/",
  };
  return { d, calls };
}

for (const stage of ["dev", "pr-12", "pr-48899"]) {
  test(`${stage}: the sink, and the production mailer factory is never called`, async () => {
    const { d, calls } = deps();
    const mailer = mailerFor(stage, d);
    assert.ok(mailer instanceof S3SinkMailer);
    await mailer.send({ to: "a@example.com", subject: "s", text: "t", html: "h" });
    assert.equal(calls.ses, 0);
    assert.equal(calls.s3, 1);
  });
}

test("prod: the production mailer, and the object client factory is never called", () => {
  const { d, calls } = deps();
  const mailer = mailerFor("prod", d);
  assert.equal(mailer, prod);
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
