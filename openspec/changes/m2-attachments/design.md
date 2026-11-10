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

Same bytes, end to end (added after the cold review of #109, finding B1). The upload policy can be posted again until it expires, so a file could be replaced after its check. The worker therefore records the ETag of the object it checked. It applies a clean verdict only when the scan event names that same ETag, and copies to `uploads/` with `CopySourceIfMatch` on it. A second upload with different bytes, or a precondition failure, refuses the file as `not_checked`. The POST policy binds `content-length-range` to exactly the declared size.

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

## Screens

Written by Design after Gate 1 (tasks 4.1 and 4.2). The approval page of `m2-approval-page` (archived design.md, Screens A0–A12) with files added; everything not named here is unchanged. Built from `packages/ui`: every state below is a component state and a Storybook story ("Screens/Files …", components under "Components/Files"); the copy is `copy.approval.files` in `packages/ui/src/screens/copy.ts`, and the two change together.

**Static HTML spec per state:** [`screens/index.html`](screens/index.html), one self-contained file per state, exported from the Storybook build by `packages/ui/scripts/export-screens.mjs attachments` (390 px reference width; light or dark follows the system). Not interactive; the interactive version is the story "Screens/Files Interactive" (choose, drop or paste real files; a name containing "eicar" plays the security check's refusal, a ZIP the type check's).

| State | Spec | Story |
|---|---|---|
| F1 No files yet: the section, its limits, the upload control | [f1-empty](screens/f1-empty.html) | Files Empty |
| F2 Uploading, with progress | [f2-uploading](screens/f2-uploading.html) | Files Uploading |
| F3 Checking | [f3-checking](screens/f3-checking.html) | Files Checking |
| F4 Ready: Send available | [f4-ready](screens/f4-ready.html) | Files Ready |
| F5a Refused: type not allowed (also name and content disagree) | [f5a-refused-type](screens/f5a-refused-type.html) | Files Refused Type |
| F5b Refused: over 25 MB | [f5b-refused-size](screens/f5b-refused-size.html) | Files Refused Size |
| F5c Refused: over 50 MB together | [f5c-refused-total](screens/f5c-refused-total.html) | Files Refused Total |
| F5d Refused: a sixth file | [f5d-refused-count](screens/f5d-refused-count.html) | Files Refused Count |
| F5e Refused by the security check | [f5e-refused-security](screens/f5e-refused-security.html) | Files Refused Security Check |
| F5f Refused: check did not finish | [f5f-refused-not-checked](screens/f5f-refused-not-checked.html) | Files Refused Not Checked |
| F5g Refused: upload did not finish | [f5g-refused-upload-failed](screens/f5g-refused-upload-failed.html) | Files Refused Upload Failed |
| F6 Several files mixed; Send unavailable while files upload | [f6-mixed](screens/f6-mixed.html) | Files Mixed |
| F7 A refused file listed among ready ones; Send unavailable | [f7-refused-listed](screens/f7-refused-listed.html) | Files Refused Listed |
| F8 Five files: adding unavailable | [f8-full](screens/f8-full.html) | Files Full |
| F9 Removing a file | [f9-removing](screens/f9-removing.html) | Files Removing |
| F10 Sending with files | [f10-sending](screens/f10-sending.html) | Files Sending |
| F11 Send refused: outside the participant's rules, with files | [f11-refused-rules](screens/f11-refused-rules.html) | Files Refused Rules |
| F11b Send refused: a file was not ready (D4 `files_not_ready`) | [f11b-not-ready](screens/f11b-not-ready.html) | Files Not Ready At Send |
| F12 Offline with files | [f12-offline](screens/f12-offline.html) | Files Offline |
| F13 Sent: files listed with the question, open only | [f13-sent](screens/f13-sent.html) | Files Sent (and Files Already Sent) |
| F14 Not sent: the files go | [f14-not-sent](screens/f14-not-sent.html) | Files Not Sent |
| F15 Phone, 390 px: a photo chosen from the library | [f15-phone-photo](screens/f15-phone-photo.html) | Files Phone Photo |

Not a static spec: the drag-over look (F1 with a file held over the zone), which needs a real drag; it is in the interactive story and described under F1. Expired, wrong principal and signed out (A10–A12) are unchanged and say nothing about files.

### F0. Roles, components, data

**Roles used** (no new token, no new colour pair; the provisional M1 roles as in A0): `--text` (file name, fact value, gating line), `--text-muted` (type and size, limits hint, drag hint, reasons the control is unavailable), `--border` (rows), `--border-strong` (drop zone edge, progress track, ghost button edge), `--surface-2` (progress track), `--accent` (progress fill, Open and Remove, the "Choose files" ghost button's text, the drop zone edge while a file is held over it), `--focus`, `--pending-*` (pills Uploading, Checking), `--success-*` (pill Ready), `--danger-*` (pill Refused and the reason under it). Spacing `--space-1…5`, radius `--radius-lg` (drop zone), `--radius-pill` (pills, progress), `--target-min`.

**Colour roles (skill §3).** A file name is the principal's own text: plain `--text`, no tint, no badge inside it. The file's state is said in words in a status pill beside it; colour is never the only signal. The progress bar is a platform element and takes the accent. No second hue.

**Components** (`packages/ui`, stories "Components/Files"):

| Component | What it is |
|---|---|
| `FileList` | `<ul>` named by the section heading; one row per file: name, "type · size", state pill, progress bar (uploading), reason (refused), then Open (ready only) and Remove. `mode="read"` for the sent page: no pill, no Remove. Native `<button type="button">`s named after the file ("Open when_to_call_v3.pdf", "Remove …"), 44 px. |
| `FileUpload` | React Aria `DropZone` around a `FileTrigger` and its ghost button **Choose files**; the hidden input has `multiple`, the `accept` list and **no `name`** (a file is never posted with the decision form). `disabledReason` shown under it and linked to the button. |
| `FileAnnouncer` | The section's polite live region (`role="status"`), empty on first paint; says each state change once (below). |
| `DecisionBar` (changed) | Gains `reason` and `reasonId`: the files' reason Send is unavailable, one line above the buttons. |
| Pure functions | `filesGate`, `gateText`, `fileAnnouncements`, `filesFact`, `formatFileSize`, `fileTypeLabel`, `acceptAttribute`, `fileHint`, `refusalText`; each pinned by `test/attachments.test.tsx`. |

**Props for the web dev** (`ApprovalScreen`, all optional; pass `files` to turn the section on):

```ts
files?: readonly ApprovalFile[];           // the request's non-deleted rows, in the order added, plus any
                                           // file the add action refused before storing (local id)
fileRules?: ApprovalFileRules;             // { accept, maxFiles, maxFileBytes, maxTotalBytes } from
                                           // packages/protocol's constants; accept in display order
onAddFiles?: (files: File[]) => void;      // chosen, dropped or pasted, in order
onRemoveFile?: (id: string) => void;       // any state; aborts an upload in progress
onOpenFile?: (id: string) => void;         // ready files only
refusal?: ApprovalRefusal | "files_not_ready";

interface ApprovalFile {
  id: string;            // request_files.id (the protocol ref), or a local id
  name: string;          // shown as text; never logged by the UI
  mediaType: string;     // recorded type once checked, else the browser's declared type
  sizeBytes: number;
  state: "uploading" | "checking" | "ready" | "refused";
  progress?: number;     // 0..1 while uploading, from the upload's progress events
  refusal?: "type" | "size" | "total" | "count" | "malware" | "not_checked" | "upload_failed";
  removing?: boolean;    // remove asked, not yet confirmed
}
```

- `total` is the page's split of D1's `size`: the add action knows whether the file itself is over 25 MB (`size`) or the request would go over 50 MB with it (`total`); neither is stored (D2 refuses before storing), so the web dev keeps such a file as a local row until the principal removes it. `count` likewise.
- `upload_failed` is what the page shows when the browser's POST to storage fails or is aborted by the network; `not_checked` and `malware` come from the row.
- The component announces, gates Send and moves focus by itself from the `files` it is given; the web dev only keeps `files` current (upload progress, then the row's state by polling or on focus, D3) and calls the actions. Sizes are bytes; the UI formats them.
- **Opening a file:** in `onOpenFile`, open the new tab synchronously in the click (`const tab = window.open("about:blank", "_blank")`; a tab opened after an `await` is blocked as a pop-up), then set `tab.opener = null` and `tab.location` to the 5-minute link the server action returns (close the tab if it returns nothing); or route through an `apps/web` handler that checks the principal and redirects to the link. Either way the approval page stays where it is, so edits to the question are never lost. Images open in the tab; PDF, text, CSV and Markdown download (D6).
- `refusal="files_not_ready"` is the error code `files_not_ready` of the `invalid` outcome (#104). It is kept out of `ApprovalRefusal` so the app's exhaustive map of refusal wordings (`apps/web/src/approval/view.ts`) keeps compiling; the web dev maps the new code when wiring Send.
- With JavaScript off, the section renders the list and the control, but adding, removing and opening need script (as "Restore agent draft"); a `<noscript>` is not added because the whole upload path needs script and Don't send still works.

### F1. No files yet

```html
<section aria-labelledby="request-files">                         <!-- between the question and "Request details" -->
  <h2 id="request-files">Files they will consult</h2>
  <p class="muted">Optional. Up to 5 files, 25 MB each and 50 MB in all: PDF, PNG, JPEG, WebP, plain text, CSV or Markdown.</p>
  <ul aria-labelledby="request-files"> … </ul>                     <!-- absent while empty -->
  <DropZone aria-label="Drop or paste files here">                  <!-- dashed --border-strong, radius 12, from 600 px -->
    <span aria-hidden>Drag files here, or</span>                     <!-- from 600 px only -->
    <FileTrigger multiple accept="application/pdf,image/png,…,.md,.markdown"><Button ghost>Choose files</Button></FileTrigger>
  </DropZone>
  <div role="status" aria-live="polite"></div>
</section>
```

The limits come from `fileRules`, so the sentence follows the protocol's constants. The section sits under the question, as the M2 slot said, because the participant reads the files with it. Under 600 px there is no drop hint and no dashed box: one full-width **Choose files** button, since phones do not drag. When a file is held over the zone (600 px and up), the edge turns solid `--accent` 2 px and the hint reads **Drop to add them**. Dropping or choosing several files adds them in order.

**Request details** gain one row after "Answer format": **Files** · **None** / **1 file, 2.4 MB** / **4 files, 5.9 MB in all**, then the note **They open them with the question. Emails to them never carry files.** Refused files are not counted (they will never be sent).

### F2–F4. One file's life

| State | Pill | Under the name | Actions |
|---|---|---|---|
| Uploading | `pending` **Uploading 42%** (or **Uploading** before the first progress event) | progress bar, accent on `--surface-2`, named "Uploading IMG_2041.jpg" | Remove (cancels the upload) |
| Checking | `pending` **Checking** | | Remove |
| Ready | `success` **Ready** | | **Open**, Remove |
| Refused | `danger` **Refused** | the reason, `--danger-text`, strong | Remove |
| Being removed | (as before) | | Remove reads **Removing…**, disabled, named "Removing {name}" (its visible word stays in its name) |

Every row: the name on the first line (wraps anywhere), **PDF · 2.4 MB** beneath it in `--text-muted` (types: PDF, PNG image, JPEG image, WebP image, Text, CSV, Markdown, else **Other type**; sizes in bytes, KB, or MB with one decimal, binary units as the limits are stated). The pill sits to the right from about 300 px of row, under the name below that.

### F5. Refusal reasons (copy)

One sentence, what happened and what to do; never the name of a detection, a scanner or a threat.

| Reason | Under the file |
|---|---|
| `type` | This type of file can't be sent. Allowed: PDF, PNG, JPEG, WebP, plain text, CSV or Markdown. |
| `size` | This file is over 25 MB, the most for one file. |
| `total` | With this file the request would be over 50 MB, the most for all files together. |
| `count` | A request can have 5 files at most. Remove one, then add this file again. |
| `malware` | The security check refused this file, so it has been deleted. |
| `not_checked` | This file couldn't be checked, so it can't be sent. Password-protected PDFs can't be sent. Remove it, or add a copy without a password. |
| `upload_failed` | The upload did not finish. Remove it and add it again. |

`not_checked` covers both a check that did not finish in 10 minutes and a file the scanner could not open (ADR 0005: `UNSUPPORTED`, `ACCESS_DENIED`, `FAILED`, for example an encrypted or unreadable file); the page does not say which, and names the commonest cause the principal can fix. A file whose name and content disagree (`report.pdf` holding HTML) is a `type` refusal with the same words: the page does not say what the content was. The refused file's bytes are deleted (spec), but its row stays listed until the principal removes it, so the reason can be read.

### F6–F7. Send unavailable and its reason

Send is unavailable while any file is uploading or checking, or any refused file is listed (spec "Send waits for checking", "Refused file blocks Send until removed"). One line above the buttons, in `--text`, strong, says why, and Send points at it with `aria-describedby` (with the question's error too when both apply):

- a refused file listed (first, because it needs an action): **Remove the refused file to send.** / **Remove the 2 refused files to send.**
- otherwise, a file uploading: **Files are uploading. Send will be available when every file is ready.**
- otherwise, a file checking: **Files are being checked. Send will be available when every file is ready.**

Don't send is never blocked by files. When the last file becomes ready (or the last refused one is removed), the line disappears, Send becomes available and the live region says **Every file is ready. Send is available.**

### F8. Five files

With five files that are not refused, **Choose files** and the drop zone are unavailable and the line under them reads **5 files is the most a request can have. Remove one to add another.** (linked to the button with `aria-describedby`). Refused files stay listed until removed but count toward neither the 5-file limit nor the 50 MB total (#104), so a refused row never blocks adding; while one is listed, the limits sentence of F1 gains **Refused files don't count toward these limits.** The `count` and `total` reasons are computed the same way.

### F9–F10. Removing; sending

Remove asks the app; the row stays with **Removing…** until the file has left `files`, then focus moves to the next file's first control, else the previous file's, else **Choose files**, and the region says **{name} removed.** While Send or Don't send is being recorded (A3), Remove and the upload control are unavailable with the rest of the form.

### F11. Send refused with files

The A4 notice, `role=alert`, focus on it, ending **Nothing was sent and nothing is held.** The files stay listed and removable; both actions stay available.

| Refusal | Title | Body |
|---|---|---|
| `outside_participant_rules` with files | It doesn't fit their rules | The participant's rules don't allow this request as it is: they may not take files, or not this much. Remove the files and try Send again, or choose Don't send and ask your agent to find someone else. |
| `outside_participant_rules` without files | (A4 wording, unchanged) | |
| `files_not_ready` (a file changed state between the page and Send) | A file isn't ready yet | Send works once every file shows Ready. Wait for the check to finish, or remove the files that are not ready. |

`files_not_ready` arrives from `decideApproval` as the error code inside the existing `invalid` outcome (#104), like the other refusal codes; the web dev passes it as `refusal="files_not_ready"` with `state="refused"`. The decision bar then shows, as on any page with files not ready, the line above Send (**Files are being checked. Send will be available when every file is ready.**, or the refused-file line) with Send unavailable until it clears; Don't send stays available.

The participant's attachment setting is published (proposal), so naming files as a possible cause discloses nothing an agent cannot read; the wording still says "may", because the refusal does not say which rule failed and the page never states the participant's limit.

### F12. Offline

The A6 notice, plus: the upload control is unavailable with **Adding files needs a connection.** An upload cut by the network becomes `upload_failed`. Rows already listed keep their state; Remove stays available (the app may fail it, then the row stays).

### F13. Sent (and already sent)

After "The question as sent", a section **Files sent with it**: the same rows in read mode (name, type and size, **Open**), no pill, no Remove, no upload control (spec "Files on a sent request"). Absent when the request had no files.

### F14. Not sent

A9 gains, after the first paragraph: **The files you added will be deleted within the hour.** (only when there were files; D5, spec "Don't send"). A8 "already not sent" and A10 "expired" say nothing about files.

### F15. Phone, 390 px, choosing a photo

**Choose files** is full width, 44 px. On iOS and Android it opens the system sheet (photo library, camera, files); with `image/jpeg` in `accept` and HEIC absent, iOS hands over a JPEG. The chosen photo appears as a row (**IMG_2041.jpg · JPEG image · 3.1 MB · Uploading 42%**) with its progress bar; the row's Open and Remove are 44 px text buttons with 24 px between them. No `capture` attribute: the principal chooses between library and camera. The page does not scroll sideways at 320 px (long names wrap anywhere).

### Announcements (polite, one live region per section)

| Change | Said |
|---|---|
| a file added | Uploading {name}. |
| uploaded, now checking | {name} uploaded. Checking it. |
| ready | {name} is ready. |
| refused (at any point, including before upload) | {name} refused. {the reason sentence} |
| removed | {name} removed. |
| the files stop blocking Send | Every file is ready. Send is available. |

Nothing on first paint and nothing per percent of progress (the bar carries the value for those who ask). Several changes in one update are said together.

### Keyboard order and focus

Sign out → question → Restore (when edited) → for each file: **Open** (ready) → **Remove** → the drop zone (React Aria's hidden drop button, labelled "Drop or paste files here"; Ctrl/Cmd+V pastes a copied file there) → **Choose files** → **Send** → **Don't send**. Enter or Space on Choose files opens the system picker; Escape closes it and focus returns to the button. Focus ring 2 px `--focus`, offset 2 px, on every stop, and on the zone's edge while its drop button is focused. Focus after removal: F9.

### Accessibility (WCAG 2.2 AA)

- The section is named by its `h2`; the list is a `<ul>` named by the same heading; each control's name includes the file name, so a list of "Remove" buttons is never ambiguous.
- State in words in every row (pill text) and in the live region; the reason is text under the name, not a colour.
- Progress is a native `<progress max=100 value>` named "Uploading {name}".
- Targets: Open, Remove, Choose files at least 44 × 44 px at every width.
- Send's unavailability is explained by text it points at; no disabled control without a reason on screen, apart from the A3 recording state as before.
- Reduced motion: nothing animates; the progress bar changes width without transition. Motion tokens unused.
- Contrast: no new pair (roles as measured in M1).

### Never on this page

A file's content, preview or thumbnail (no server-side rendering of files in this change); a detection or scanner name; a file name in any URL, log line or announcement other than the live region; a file input that posts with the decision; a third action in the decision bar; the participant's attachment setting or limit.

### Prototype and PRD

- The prototype's meta line "414 / 2000 · 1 attachment" under the question and the participant card "when_to_call.pdf · 140 words · opens here" are not followed: the files have their own section with states, which a count in the meta line cannot show, and word counts need reading the content, which the page never does. **Followed the spec** ("show each file's name, type, size and state").
- The M2 slot said each row would show "opens here"; replaced by **Open**, a button, because D6 opens files in a new tab or downloads them, never inside the page.

### Review on Storybook (2026-11-08)

`packages/ui`: 98 tests (40 new in `test/attachments.test.tsx`, written first and seen failing: 35 red before the components existed), typecheck and lint green; `apps/web` typecheck, lint and tests green against the new `@a2h/ui`. Storybook build; Playwright (Chromium 1.64) over 83 stories (every "Components/Files", "Screens/Files …", approval screen and approval component story, so the M2 states are re-checked too) at 320, 390 and 1280 px, light and dark, each by `prefers-color-scheme` and by `data-theme`, reduced motion on: axe-core 4.14 (WCAG 2.0/2.1/2.2 A and AA plus best practice), a 44 px target check and a horizontal-overflow check. Result: 996 runs, no finding. The first run found one axe violation (`label-content-name-mismatch` on **Removing…**, named "Remove {name}"); fixed by naming it "Removing {name}", test first. React Aria's drop button is visually hidden (it takes keyboard focus and paste, never a pointer) and is left out of the target check. Keyboard-only pass on "Screens/Files Interactive" at 320 light and 1280 dark: Tab order as above with a visible 2 px ring at every stop; Enter on **Choose files** opens the picker (multiple); choosing a PDF and a file named `eicar-notes.txt` announces "Uploading when_to_call.pdf. Uploading eicar-notes.txt."; Send is unavailable while they upload; the second is refused by the security check, the region says so with the reason and the line above Send reads "Remove the refused file to send."; Space on its Remove removes it, focus moves to the remaining file's Open, the region says "eicar-notes.txt removed. Every file is ready. Send is available." and Send is available; removing the last file moves focus to **Choose files**; Space on Send lands on "Question sent" with focus on the h1. Not run: a screen reader (the announcements were read from the live region's text, not heard), browsers other than Chromium, a real phone's picker (iOS HEIC to JPEG is from Safari's documented behaviour, not observed), drag and drop with a real pointer, the built page in `apps/web` (group 5; Design reviews it on the preview).

**Update after ADR 0005 and #104 (2026-11-08):** `not_checked` wording covers files the scanner cannot open (password-protected PDFs named); refused files no longer count toward the 5-file and 50 MB limits, and the limits sentence says so while one is listed; `files_not_ready` documented as the code inside `invalid`. 99 tests (2 new or changed, seen failing first); Storybook rebuilt, specs regenerated; axe, target and overflow pass re-run on the 47 file stories at 320, 390 and 1280 px, light and dark, both theme mechanisms: 564 runs, no finding. The keyboard pass above was not repeated (no control or focus behaviour changed).

### Copy questions for the product owner

1. **Refused pill.** "Refused" (as the spec and proposal word it), or the softer "Not accepted"? Recommended: **Refused**, paired with a reason that says what to do.
2. **Rules refusal with files.** The page says the participant "may not take files, or not this much" and suggests removing them. Recommended as written, since the setting is published. Alternative: keep the M2 wording unchanged and say nothing about files.
3. **Warn before uploading?** The page could say up front "This participant doesn't take files" from the published setting, instead of refusing at Send. Not in the spec; the Gate 2 step "Send to the participant whose rules refuse files: refused" relies on the refusal. Recommended: not in this change; revisit with M3.
