# Tasks: m2-attachments

Gate 1 passed 2026-11-08 (all five recommendations). Owners: PD = Protocol dev, WD = Web dev, QA, Design, PM. Every task is test first; each scenario of the four deltas maps to a named test (`tests/README.md`).

## 1. Decisions and ADR (PM, PD)

- [x] 1.1 PM: record the Gate 1 answers (types, scanner, limits, participant default, retention) in proposal.md and adjust the deltas if any answer differs from the recommendation — done 2026-11-08: every recommendation accepted; no delta changes
- [x] 1.2 PD: ADR 0005 "Malware scanning of uploads" (GuardDuty Malware Protection for S3 vs ClamAV; cost per GB; the provider-neutral result interface of D3); acceptance: ADR merged with the owner's choice — done in #103 (ADR 0005: GuardDuty Malware Protection for S3 on `tmp/` only; per-stage EventBridge rule to SQS; tag read control scoped to tmp/; UNSUPPORTED/ACCESS_DENIED/FAILED, incl. password-protected PDFs, refused as not checked)

## 2. Protocol and data (PD)

- [x] 2.1 `packages/protocol`: allowed media types and limits as constants (5 files, 25 MB, 50 MB); `RulesOfEngagementSchema.attachments` with its read default; `check_requests` item `files`; JSON Schema export and snapshots; tests for "Setting present", "Rules without the setting", "Request with files", "Request without files" — done in #104
- [x] 2.2 `validateManifest`: attachment setting at the participant-rules stage; pure tests for "Participant does not accept files", "Files over the participant's total", "Request without files is unaffected" — done in #104
- [x] 2.3 `packages/db`: migration 0012 (`request_files`, rules columns), schema, drift test; queries to insert, list, mark, remove and delete files; Data API stand-in tests for every web-side query (amendment 3) — done in #104 (migration 0012 with an immutability trigger; Data API stand-in tests)
- [x] 2.4 `decideApproval`: files `FOR UPDATE`, `files_not_ready`, `attachments` into the manifest and the row, immutability after Send; tests for "Add and send", "Send waits for checking", "Removing the files makes it sendable", "Sent files are fixed", concurrent remove versus Send — done in #104 (`files_not_ready` as a ProtocolErrorCode in the `invalid` outcome; remove-vs-Send race 12 rounds, both orders)
- [x] 2.5 Seed: simulated personas covering refuse-files and a 5 MB total; seed test pins them — done in #104 (sim-th-2a91 refuses files, sim-ol-6a23 accepts up to 5 MB)

## 3. Infra and worker (PD)

- [ ] 3.1 `infra/`: bucket CORS for each stage's web origin (POST only), prefix-scoped grants for web (`tmp/*/files/` write, `uploads/*/files/` read) and worker (both areas read, write, delete), scanner protection plan and event routing per ADR 0005; infra tests
- [ ] 3.2 `apps/worker`: `file-check` (content sniffing; tests per type, including "Name and content disagree"), scan-result handling (clean, threat, error), the 10-minute `not_checked` job, `files-delete` on not_sent; tests for "Clean file", "Malicious file", "Scan does not finish", "Don't send", "Link expires"
- [ ] 3.3 `apps/mcp`: `check_requests` files summary; `request_human` refusal wording for `attachments` ("Attachments from the agent"); "Agent checks a request with files"; logging test that no file name appears

## 4. Design (Design)

- [x] 4.1 `design.md` Screens: file list and upload control in every state, the decision bar with Send unavailable and its reason, sent page with files, phone at 390 px; copy for each refusal reason; static specs in `screens/` — done 2026-11-08 (design.md Screens F0–F15, 22 specs)
- [x] 4.2 `packages/ui`: components and stories, axe and keyboard pass at 320/390/1280 light and dark — done 2026-11-08 (996 runs, no finding; design.md "Review on Storybook")

## 5. Approval page (WD)

- [ ] 5.1 Server actions: add (limits, presigned POST), remove, open (presigned GET), each behind the page's principal and token checks; tests for "Too large", "Too many", "Another account", "Old link", "Principal opens their file"
- [ ] 5.2 Page: upload with progress straight to S3, states by polling or on focus, Send gating, refusal messages; Playwright for "Add and send", "Refused file blocks Send until removed", "Remove a file", "Files on a sent request", "Keyboard and phone"
- [ ] 5.3 Logging: file names never logged (test over every new log line)

## 6. Verification (QA)

- [ ] 6.1 Contract and e2e for every scenario of the four deltas on the preview, named after them; `tests/README.md` map
- [ ] 6.2 Adversarial: upload to another principal's request; reuse an expired upload policy; oversize body against the policy; content-type spoofing; EICAR; reading a file by guessing its key; adding a file after Send; racing remove and Send. Each red against a weakened check, then green on the preview
- [ ] 6.3 Fixtures: small PDF, PNG, JPEG, WebP, text, CSV, Markdown, a disguised HTML file, EICAR; nothing over 1 MB committed (large files generated in the test)

## 7. Docs, review and gate (PM)

- [ ] 7.1 Runbook: scanner operation and cost; PRD §6 request card paragraph mentions attachments as built
- [ ] 7.2 Cold review of the change PR (missing tests, spec drift, the one rule: nothing reaches a participant that their rules do not allow, nothing unchecked is ever sent)
- [ ] 7.3 Gate 2 post with the preview link and the owner's steps from proposal.md
