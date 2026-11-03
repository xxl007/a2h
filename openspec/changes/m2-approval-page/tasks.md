# Tasks

Owners: **PD** protocol-dev (packages/protocol, packages/db, apps/mcp, apps/worker), **WD** web-dev (apps/web), **DS** design (packages/ui, Screens in design.md), **QA** qa (tests/, workflows), **PM**, **Owner**. One PR for the change into `main`, built from one PR per task group into the change branch `feat/m2-approval-page`. Every task: failing test first, then the code, then green. Nothing starts before Gate 1.

## 1. Spike: URL elicitation in the two clients (PD with Owner, before group 3)

- [x] 1.1 PD: a throwaway branch where `request_human` on a preview answers with a URL-mode elicitation pointing at a static page; verify with MCP Inspector that the elicitation is well-formed and the retry completes, and record the Inspector version — done (PR #78, draft, never merged): throwaway tool `approval_link_spike` on pr-78; Inspector 2.13.0 web client declares `elicitation.url`, shows the link, retry returns accept or cancel (no decline button); Inspector CLI declares no elicitation; the verify job's official client passed accept, decline and cancel on the preview; finding: no `elicitationId` on 2026-07-28, request id goes in `requestState` (D3 amended)
- [ ] 1.2 Owner: from claude.ai and Claude Code, call it once each; report whether the client declared `elicitation.url`, what it showed, and what happened on accept and decline; PD pastes the preview log lines (methods, capabilities, outcome; no bodies) into this file; PM records the result and adjusts D3's wording if needed

## 2. Protocol and data (PD)

- [x] 2.1 `packages/protocol`: status set with `awaiting_approval` and `not_sent` (reason `declined` or `expired`), the transitions and actors of spec `protocol/request-lifecycle`, and the `request_human` output of spec `protocol/schemas`; verify the lifecycle tests ("Legal transitions", "Illegal transition", "Agent cannot approve") and the schema fixtures ("Awaiting approval", "Request not sent") pass, and the JSON Schema export changes accordingly — done in PR #80
- [x] 2.2 `packages/db`: forward-only migration for the new statuses and the columns of D1 (`agent_draft`, `approval_token_hash`, `approval_expires_at`, `not_sent_reason`); queries `createAwaitingRequest`, `decideApproval` (D4's transaction, `FOR UPDATE`), and the shared loaders for participant rules, policy and counts used by both apps; verify `constraints.test.ts`, the drift test, and a test that two concurrent decisions produce one transition — done in PR #80: migration 0009, `createAwaitingRequest`, `decideApproval` with `FOR UPDATE`, shared loaders; daily limit counts sent requests only (D4)
- [x] 2.3 `apps/worker`: delivery selects `sent` only and never counts `awaiting_approval`; the minute job expires approvals (D6); verify "Approval link expiry by the platform" and a test that an `awaiting_approval` row past its delivery time is never delivered — done in PR #80: approval expiry in the minute job; delivery never selects `awaiting_approval`

## 3. MCP tools (PD, after 2)

- [ ] 3.1 `request_human` records the request and returns the link (D1–D3), URL elicitation where declared, text otherwise; the form path, approval-state codec and replay table removed (D5); verify "Link returned", "Client with URL elicitation", "Client without URL elicitation", "Principal refuses to open the link", "Return under a second", and that the tool descriptions state the new flow
- [ ] 3.2 `check_requests` reports the link and expiry while awaiting, and the reason when not sent; verify "Awaiting approval" and "Not sent"

## 4. Design (DS, after Gate 1, parallel to 2)

- [x] 4.1 Screens section of design.md: the approval page and every state of spec "Every state of the page is stated", copy (EN), tokens used from the provisional set, the fee breakdown layout, keyboard order, the 320 px layout; verify a static HTML spec per state is linked from design.md and reviewed by the owner on the preview of this PR — done in PR #79 (merged 2026-11-03): Screens A0–A12 in design.md, static HTML specs per state in `screens/`, owner review page published; three copy questions open with the owner (fee breakdown, simulated note, link validity line). Storybook is not deployed on previews: the static specs are the review artifact
- [x] 4.2 `packages/ui` components the page needs (question editor with count and restore, fact list, decision bar) with Storybook stories and their states; verify the a11y checks in Storybook pass and no colour value is written outside `packages/ui/tokens` — done in PR #79: QuestionEditor, FactList, DecisionBar, StatusPill, LocalTime; axe, 44 px targets and overflow over 34 stories at 320, 390, 1280 px, light and dark: 204 runs, no findings

## 5. Approval page (WD, after 2 and 4)

- [ ] 5.1 Route `/approve/[id]` (D7): session and principal check, token check, every state; verify the scenarios of "Only the request's principal sees the request" and "Every state of the page is stated" in `apps/web` tests
- [ ] 5.2 Send and Don't send server actions (D4) with re-validation through the shared loaders; verify "Send on the page", "Don't send on the page", "Accept after editing", "Edit turns the question into a push-poll", "Budget spent meanwhile", "Decision replayed", "Forged token", "Another principal opens the link"
- [ ] 5.3 Question editor behaviour; verify "Restore agent draft", "Over the limit", "Enter in the question", "Labels", "Poll request", "Simulated participant", "Time zone" with Playwright
- [ ] 5.4 Accessibility; verify "Keyboard only" and "Narrow screen" with Playwright and axe on the preview

## 6. Verification (QA)

- [ ] 6.1 Contract tests for every scenario of the four deltas, named after them, against the preview; the table in `tests/README.md` updated; the suites that drove the old form (`request-approval`, `request-flows`) rewritten to approve through the page with the QA principal's session
- [ ] 6.2 Adversarial: approving another principal's request, replaying a decision, forging and guessing tokens, sending after the link expired, an agent trying to move a request out of `awaiting_approval` through any tool; each red against a weakened check locally, then green on the preview
- [ ] 6.3 Hosted-client check: claude.ai and Claude Code each show the link and the outcome reaches `check_requests`; record in `docs/runbooks/mcp-setup.md`

## 7. Docs and gate (PM)

- [x] 7.1 PRD §6 request-card paragraph (implementation sentence) and ADR 0003 item 6 amended for decision 7; verify both link this change — done 2026-11-03: PRD §6 request-card paragraph and ADR 0003 amendment 1
- [ ] 7.2 Cold review of the change PR (missing tests, spec drift, the one rule: nothing is sent that the principal did not approve on the page); verify findings resolved or recorded here
- [ ] 7.3 Gate 2 post with the preview link and the owner's steps from proposal.md; verify the owner's validation is recorded before archive

## Workflow follow-up

- Archive after Gate 2; the specs become the living truth.
- Next change: attachments on the approval page and in delivery (proposal decision 1), then `m2-design-foundations`.
