# Proposal: m2-attachments

Owner decisions of 2026-11-08: the principal adds files on the approval page in this change (agent-supplied files come later); participants open files with the M3 request page.

## Why

Some questions cannot be answered without a document: a leaflet to judge, a contract clause, a chart. Today `request_human` refuses any manifest with attachments, and the approval page has no place for files. Owner decision 7 (2026-11-01) chose the hosted approval page partly so that files could be added and checked there before anything is sent; this change delivers that, ahead of the participant's request page (M3), so that the storage, limits and checks exist when M3 needs them.

## What Changes

- **Attach on the approval page.** While a request awaits approval, its principal can add up to 5 files (25 MB each, 50 MB in all) and remove them. Each file shows its name, type, size and state (uploading, checking, ready, refused). The principal can open their own files from the page. Send is available only when every file is ready.
- **Allowed types, checked by content.** PDF, PNG, JPEG, WebP, plain text, CSV and Markdown. The type is read from the file's bytes on the server, not from its name or the browser's claim; a mismatch is refused.
- **Malware check before Send.** Every file is scanned after upload; a file flagged as malicious is refused and removed, and the page says so without naming the detection.
- **Files follow the participant's rules.** Rules of engagement gain a published setting for attachments (accepted or not, and a total size the participant will take). Send re-validates with the files: a request whose files the participant's rules do not allow is refused, like any other rule. Simulated participants publish settings that cover both cases.
- **Files are part of what was approved.** On Send, the files become the manifest's `attachments` (reference, type, size); nothing about them changes after Send. On Don't send, or when the link expires, the files are deleted. After Send they are kept for the request's retention and deleted with it.
- **Agents see that files exist, not their content.** `check_requests` reports the number and types of attached files; agents cannot add, read or remove files in this change. `request_human` still refuses a manifest that carries `attachments`, now naming the approval page as the way to add them.
- **Participants.** Simulated participants receive the file list (type and size) and answer as today. Real participants open files from the M3 request page; emails continue to carry the summary only, never file names or content.

## Capabilities

### New Capabilities
- `platform/attachments`: storing, checking, limiting and deleting files attached to a request; who may read them and how.

### Modified Capabilities
- `platform/approval-page`: adding, removing and opening files before Send; Send waits for every file to be ready.
- `protocol/request-approval`: agent-supplied attachments refused with a pointer to the page; Send validates the files against the participant's attachment rules.
- `protocol/schemas`: rules of engagement gain the attachment setting; `check_requests` items gain the file summary.

## Impact

- `packages/protocol`: rules shape, `check_requests` output, validation of attachments against rules, allowed media types and limits as constants.
- `packages/db`: an attachments table (one row per file, its state, its object key, the request), migration; `decideApproval` takes the files into the manifest; deletion on Don't send and expiry.
- `apps/web`: upload and removal on the approval page through short-lived signed upload links; opening a file through a short-lived signed download link; states.
- `apps/worker`: content-type check and scan outcome handling; deleting files of unsent requests.
- `apps/mcp`: `check_requests` summary; the refusal wording.
- `infra/`: the web Lambda's write access to the upload area, bucket CORS for the page's origin, the malware-scanning service on the uploads bucket, event routing to the worker. ADR for the scanner.
- `packages/ui`: file list, upload control and its states (Design).
- Participant-side display waits for M3; nothing in `apps/web` shows files to anyone but the request's principal.

## How the product owner validates (Gate 2)

On the change's preview, signed in with your allow-listed address: have an agent prepare a question, open the approval link, add a PDF and an image, remove one, open the other, and Send. Ask the agent to check the request: it reports one attached PDF or image. Then try a file of a type that is not allowed, a file over 25 MB, and the standard EICAR test file (harmless, recognised by every scanner): each is refused with a plain message, and Send stays unavailable until it is removed. Send to the simulated participant whose rules refuse files: refused. Don't send a request with files: they are gone. Open the page on a phone and add a photo from it.

## Decisions at Gate 1

1. **Allowed types.** Recommended: PDF, PNG, JPEG, WebP, plain text, CSV, Markdown. Alternative: also Office documents (docx, xlsx, pptx); they can carry macros and external links and need conversion or a stricter scan, so they would come later.
2. **Malware scanner.** Recommended: Amazon GuardDuty Malware Protection for S3 on the uploads bucket (managed, EU region, priced per GB scanned; an ADR records it and keeps the check behind a provider-neutral interface). Alternative: ClamAV in the worker container (no per-GB cost, but we maintain signatures and memory sizing).
3. **Limits.** Recommended: 5 files, 25 MB each (already the protocol's limit), 50 MB per request. Confirm or change.
4. **Participant attachment setting.** Recommended: a participant's rules say whether they accept files and up to what total size; it defaults to "accepts, up to 50 MB" until participants can set it in M2 onboarding, and simulated participants cover both cases. Alternative: no participant setting until onboarding; files are accepted by everyone meanwhile. The recommendation keeps the one rule: nothing reaches a human that their rules do not allow.
5. **Retention.** Recommended: files of a sent request are kept 180 days (the bucket's existing retention) and deleted with the request on erasure; files of unsent requests are deleted at once. Confirm, or name a shorter period.
