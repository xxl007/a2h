# Design: m2-attachments

## Context

- The uploads bucket exists per account (`infra/storage.ts`), with key areas `uploads/` (180-day retention, `UPLOAD_RETENTION_DAYS`) and `tmp/` (7-day expiry, meant for unfinished presigned uploads), each prefixed by the stage (`STORAGE_PREFIX`: `dev/`, `pr-<n>/`, `prod/`). Preview stages get grants scoped to their prefix (`infra/access.ts`). Bucket CORS is configured but no app code writes to it yet; only the mail sink uses S3 (`apps/web/infra/mail.ts`).
- The protocol already has `AttachmentSchema` (`ref`, `media_type`, `size_bytes ≤ 25 MB`) and `ATTACHMENTS_MAX = 5` on the manifest; `request_human` refuses `attachments` (`apps/mcp/src/tools/request-human.ts:93`). `requests.attachments` is a jsonb column, unused.
- Send is `decideApproval` (`packages/db/src/queries/approval.ts`): one transaction, the request row `FOR UPDATE`, re-validation through the pure `validateManifest`. The web app reaches Aurora through the Data API, with the rules in ADR 0001 amendment 3 (one statement at a time per transaction, typed date binding, unique violations read from the message).
- The worker runs pg-boss jobs on Fargate; AWS SDK use is confined to `apps/*/infra` and `infra/` (CLAUDE.md).

## Goals / Non-Goals

**Goals:** files can be added and removed on the approval page only by the request's principal; nothing unchecked or disallowed is ever part of a sent request; the set of files is fixed at Send and validated against the participant's rules in the same transaction as the rest; files never appear in logs, emails or MCP results; files of unsent requests disappear.

**Non-Goals:** agent-supplied files (MCP upload); participant-side viewing (M3); Office documents; previews or thumbnails generated on the server; editing files; virus re-scans of stored files.

## Decisions

### D1 Data model: one row per file
New table `request_files`: `id` (opaque, 16 random bytes base64url, the protocol `ref`), `request_id`, `principal_id`, `name` (as given, at most 255 characters, never logged), `declared_type`, `media_type` (set by the content check), `size_bytes`, `state` (`uploading` | `checking` | `ready` | `refused`), `refused_reason` (`type` | `size` | `count` | `malware` | `not_checked` | `upload_failed`), `object_key`, `created_at`, `ready_at`, `deleted_at`. CHECK constraints on state/reason pairs and sizes; index on `(request_id) WHERE deleted_at IS NULL`. The manifest's `attachments` is written once, at Send, from the ready rows. Alternative: files only in the jsonb column. Rejected: state per file and concurrent updates need rows and locks.

### D2 Upload: browser to S3 through a presigned POST
A server action, after the same principal and token checks as the page, checks the count and total limits, inserts the row (`uploading`) and returns a presigned POST for `tmp/<prefix>files/<request_id>/<file_id>`, valid 5 minutes, whose policy fixes the key, `content-length-range` 1..25 MB and the declared `Content-Type`. The browser posts the file straight to S3 (no file passes through the Lambda, whose payload limit is 6 MB). The bucket CORS allows POST from the stage's web origin only. Alternative: presigned PUT. Rejected: a PUT URL cannot bound the size.

### D3 Check: content sniffing, then malware scan, in the worker
S3 `ObjectCreated` on `tmp/*/files/` triggers the scan service (D9) and notifies the worker. The worker job (pg-boss `file-check`): reads the first 8 KB with a ranged GET, identifies the type from the bytes (PDF, PNG, JPEG, WebP signatures; text, CSV and Markdown as valid UTF-8 without NUL bytes and with an allowed declared type), compares with the declared type, and marks the row `checking` or `refused` (`type`). The scan result arrives as an event; on clean, the worker copies the object to `uploads/<prefix>files/<request_id>/<file_id>` with the recorded `Content-Type`, deletes the `tmp/` object, and marks `ready`; on threat, deletes and marks `refused` (`malware`). A pg-boss job scheduled 10 minutes after upload refuses any row still not `ready` (`not_checked`). The interface the worker codes against is `FileScanResult { file_id, outcome: clean | threat | error }`; how results arrive is in `apps/worker/infra`.

### D4 Send includes the files in the locked transaction
`decideApproval` with Send, after its existing lock and checks: selects the request's non-deleted file rows `FOR UPDATE` (one statement, as amendment 3 requires); refuses with a new outcome `files_not_ready` if any is not `ready`; builds `attachments` from them (id as `ref`, `media_type`, `size_bytes`); passes the manifest with `attachments` and the participant's current rules to `validateManifest`, which checks the attachment setting at the participant-rules stage; on success writes `requests.attachments` and the transition in the same transaction. From then on the rows are immutable: the server actions for add and remove check `status = 'awaiting_approval'` under the request lock.

### D5 Removal and deletion
Remove (principal, awaiting only): mark `deleted_at`, delete the object (either area) at once. Transitions to `not_sent` enqueue a `files-delete` job for the request (within the hour; the `tmp/` 7-day expiry is the backstop). Sent files live under `uploads/` and fall under the existing 180-day rule; erasure (later) deletes by prefix.

### D6 Reading a file
A server action checks the principal and the token (as the page does) and returns a presigned GET valid 5 minutes for the `ready` object, with `ResponseContentType` set to the recorded `media_type`, `ResponseContentDisposition: attachment` for PDF, text, CSV and Markdown and `inline` for images, and the bucket serving `X-Content-Type-Options: nosniff`. Nothing is served from the web origin, so no file can run script there.

### D7 Rules: attachment setting
`RulesOfEngagementSchema` gains `attachments: { accepted: boolean, max_total_bytes: int ≤ 52428800 }`, optional on read with the default `{ accepted: true, max_total_bytes: 52428800 }` (proposal decision 4). The `rules` table gains two columns with those defaults. `validateManifest` refuses at the participant-rules stage when `attachments` is non-empty and not accepted, or over the total. Simulated personas: one refuses files, one accepts up to 5 MB, the rest the default.

### D8 What agents and simulated participants see
`check_requests` items gain `files: [{ media_type, size_bytes }]`. The simulated participant receives the same list in its delivery payload and answers as today. No file content is read by any agent or simulation.

### D9 Scanner: GuardDuty Malware Protection for S3
Chosen (proposal decision 2), recorded in ADR 0005 with the facts checked against the AWS documentation on 2026-11-08: a protection plan on the uploads bucket (independent feature, no GuardDuty detector) for the literal prefix `tmp/` only (prefixes cannot use wildcards and at most 5 are allowed, so per-preview prefixes are impossible; `uploads/` stays unprotected so the clean copy is not scanned and billed twice), with tagging on (`GuardDutyMalwareScanStatus`). Results are events on the account's default EventBridge bus, delivered at least once; each stage has its own EventBridge rule, matching its `tmp/<STORAGE_PREFIX>files/` key prefix, into its own SQS queue read by `apps/worker/infra`, which maps `NO_THREATS_FOUND` → `clean`, `THREATS_FOUND` → `threat`, and `UNSUPPORTED`, `ACCESS_DENIED`, `FAILED` → `error` (refused `not_checked`; this includes password-protected PDFs) and drops the detection name. Tag-based access control is scoped to `tmp/`, exempts the scanner's and the worker's roles by `aws:PrincipalArn` (the worker reads the first 8 KB before the scan may end), and the web role's read on `uploads/*/files/` requires the clean tag, which `CopyObject` carries over. Behind D3's interface so ClamAV in a sidecar can replace it without touching the worker logic.

### D10 Page and components
Design owns the file list and upload control in `packages/ui` (states uploading with progress, checking, ready, refused with reason; drop zone and a button; keyboard and screen-reader announcements), added to `ApprovalScreen`'s facts and decision bar ("Send" disabled with the reason). Screens added to the change's `screens/`.

## Risks / Trade-offs

- **Scan latency** (seconds to minutes) delays Send. Mitigation: states on the page; the 10-minute limit refuses instead of waiting forever.
- **Scanner cost** per GB on a public preview pipeline. Mitigation: limits per request; previews scan only what tests upload (EICAR and small fixtures).
- **Content sniffing is not validation of a PDF's internals.** A malicious but well-formed PDF relies on the scanner. Participants open files outside our origin; M3 decides whether to render PDFs in a sandboxed viewer.
- **Cross-account events and the Data API** add moving parts to previews. Mitigation: previews share dev's bucket with prefix-scoped grants as today; the worker filters events by prefix.
- **The participant default ("accepts up to 50 MB")** sends files to real participants who never chose it, once M3 exists. Mitigation: onboarding (M2) asks the question; until real participants exist only simulated ones receive files.

## Migration Plan

Migration 0012: `request_files` table; `rules` gains `attachments_accepted boolean NOT NULL DEFAULT true` and `attachments_max_total_bytes integer NOT NULL DEFAULT 52428800`. Forward only, no data to move. Infra: CORS rule, GuardDuty protection plan, event routing, worker and web grants on `tmp/*/files/` and `uploads/*/files/`; deployed through SST in CI.

## Open Questions

Proposal decisions 1 to 5 (types, scanner, limits, participant default, retention). None blocks the design beyond the choice of scanner, which changes D9 and its ADR only.
