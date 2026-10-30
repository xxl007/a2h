# @a2h/email

Email for A2H: a provider-neutral `Mailer`, React Email templates, and two
delivery implementations chosen by stage. Change: `openspec/changes/m1-hosted-connector`
(design D6 mail sink, D10 logging; spec `platform/principal-identity`).

## Entry points

| Import | What | AWS import |
|---|---|---|
| `@a2h/email` | `Mailer`, `Message`, `stageLabel()`, `renderMagicLink()` | none |
| `@a2h/email/sink` | `S3SinkMailer` (every stage but prod); injected put-only client | none |
| `@a2h/email/ses` | `SesMailer` (prod only); injected `SESv2Client` | `@aws-sdk/client-sesv2` |
| `@a2h/email/factory` | `mailerFor(stage, deps)` | via `./ses` |

`src/ses.ts` is the only module here allowed to import an AWS SDK (enforced in
`eslint.config.mjs`). It is the email counterpart of `apps/*/infra`: business
logic stays provider-neutral, and changing provider means a new entry point,
not a rewrite.

## What each stage does with a message

| Stage | Mailer | Result |
|---|---|---|
| `prod` | `SesMailer` | Sent through SES from the configured sender, with the configuration set if given. `send` returns the SES message id. |
| `dev` | `S3SinkMailer` | Written to `s3://<UPLOADS_BUCKET>/dev/mail/<id>.json`. Nothing is sent. |
| `pr-<n>` | `S3SinkMailer` | Written to `s3://<UPLOADS_BUCKET>/pr-<n>/mail/<id>.json`. Nothing is sent. |

`mailerFor(stage, deps)` takes client *factories*: the SES client is
constructed on `prod` only and the object client only elsewhere, so no
non-prod stage can send email by construction (scenario "Preview sign-in").
Any stage name other than `dev`, `prod` or `pr-<n>` throws.

```ts
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { renderMagicLink, stageLabel } from "@a2h/email";
import { mailerFor } from "@a2h/email/factory";

const mailer = mailerFor(process.env.STAGE!, {
  sesClient: () => new SESv2Client({}),
  objectClient: () => {
    const s3 = new S3Client({});
    return {
      putObject: (a) =>
        s3.send(new PutObjectCommand({ Bucket: a.bucket, Key: a.key, Body: a.body, ContentType: a.contentType })),
    };
  },
  from: process.env.EMAIL_SENDER!,
  bucket: process.env.UPLOADS_BUCKET!,
  storagePrefix: process.env.STORAGE_PREFIX!,
});

const email = await renderMagicLink({ link, expiresInMinutes: 15, productName: "A2H", stage: stageLabel(stage) });
const { id } = await mailer.send({ to, ...email });
```

(The S3 adapter lives with the caller, in `apps/web`'s infra-side code.)

## Sink objects

One JSON object per message, key `<STORAGE_PREFIX>mail/<id>.json`, where `id`
is a ULID (millisecond time first), so the lexically last key is the newest:

```json
{ "to": "…", "subject": "…", "text": "…", "html": "…", "sent_at": "2026-10-30T09:10:00.000Z", "id": "01K…" }
```

Read it with the stage's deploy role (the bucket is private; this package only
ever puts):

```sh
newest=$(aws s3api list-objects-v2 --bucket <bucket> --prefix <prefix>mail/ \
  --query 'sort_by(Contents,&Key)[-1].Key' --output text)
aws s3 cp "s3://<bucket>/$newest" -
```

e.g. `<prefix>` = `pr-12/`. The QA helper `tests/lib/mail-sink.ts` (task 6.2)
wraps this and filters by recipient.

## SES identity

The sending identity (domain, DKIM) and any configuration set are created by
infra (task group 1), not by this package. The caller passes the sender
address and configuration set name from stage configuration.

## Logging

This package logs nothing. `send` returns an opaque id the caller may log;
recipients, subjects, bodies and links never go to a log (design D10).

## Templates

### Magic link (`renderMagicLink`)

Inputs: `link` (https only), `expiresInMinutes` (whole, 1 to 15),
`productName`, and `stage`, the non-prod label from `stageLabel()`
("development", "preview pr-<n>"; `undefined` on prod, where no label shows).
Returns `{ subject, html, text }`. It states the validity, that the link works
once, and to ignore the email if not requested. It carries nothing else: no
address, no name, no client, no image.

No colour yet: `packages/ui` has no tokens until `m2-design-foundations`, and
no colour value may be written outside it, so the link keeps the mail client's
default link colour.

See it rendered:

```sh
pnpm --filter @a2h/email preview   # writes out/magic-link.{prod,preview}.{html,txt}
```

The text version is pinned in `test/__snapshots__/magic-link.prod.txt`; update
it deliberately with `UPDATE_SNAPSHOTS=1 pnpm --filter @a2h/email test`.

## Tests

`pnpm --filter @a2h/email test` (node:test, type stripping; templates are
written with `createElement` because type stripping has no JSX).
