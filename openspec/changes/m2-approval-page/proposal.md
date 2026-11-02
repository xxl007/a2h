# Proposal

Milestone M2, first change (PRD §10), placed before `m2-design-foundations` by owner decision 7 (2026-11-01, recorded in `openspec/changes/archive/2026-11-02-m1-hosted-connector/tasks.md`, "Spike result"). Tracking: labels `change:m2-approval-page`, `milestone:M2`.

## Why

The principal approves every request before anything leaves (the one rule), but today that approval is an MCP form the host draws: claude.ai collapses it into one unreadable paragraph, shows line breaks as symbols and labels its own buttons, and no amount of copy fixes a layout we do not own. The owner rejected it after the M1 spike and chose a page A2H owns: readable in every host, Claude Code included, and the only surface with room for what comes next (attachments the participant must consult, voice and video answer formats).

## What Changes

- **`request_human` no longer asks inside the client.** After validation passes it records the validated request as awaiting approval, places no hold, delivers nothing, and returns at once with an approval link, the request id and when the link expires. **BREAKING** for clients: the result has a new status, and the MCP form round trip (the `input_required` approval and its approval state) is removed.
- **Where the client supports it, the link is offered as an MCP URL elicitation** so the host shows its own "open this page" prompt; everywhere else the link is in the tool result text for the agent to show. Clients on revisions before 2026-07-28 and clients without forms, refused today, now work.
- **The approval page** in `apps/web`, signed in as the request's principal and nobody else: the question editable in place with "Restore agent draft", a character count, the participant (display label and whether simulated), request type, answer format, poll options or scale verbatim, the hold (gross, with the fee breakdown), expiry in the viewer's own time zone, data terms, delivery timing. Two actions: "Send · hold €N" and "Don't send". States for loading, expired link, already decided, signed out, another principal's link, and validation failure after an edit.
- **Send re-validates server side** (the edited text, participant rules, budget, throttle, the principal's allow-list and verification), then places the hold and starts delivery, in one transaction. "Don't send" and expiry of the link create nothing that reaches a participant and hold no money.
- **`check_requests` reports the new state**, so the agent learns the outcome: awaiting approval, then sent (and on through the existing states) or not sent (declined, or link expired).
- **Attachments, voice, video, notification email for pending approvals, principal dashboard: not in this change** (see decisions 1 and 4).

## Capabilities

### New Capabilities
- `platform/approval-page`: the hosted page where a principal reviews, edits and approves or refuses one request: who may open it, what it shows, its states and its accessibility.

### Modified Capabilities
- `protocol/request-approval`: approval moves from the client's form to the hosted page; the link, its expiry and single use; re-validation on send; form-only scenarios removed; validation order and the principal requirement unchanged.
- `protocol/request-lifecycle`: a request may wait for approval before it is sent; new states and transitions; `check_requests` reports them.
- `protocol/schemas`: `request_human` output carries the awaiting-approval outcome with its link; the status set grows.

## Impact

- `packages/protocol`: request status set, `request_human` output, transitions; no I/O added.
- `packages/db`: the awaiting-approval request (row, approval token hash, expiry), forward-only migration.
- `apps/mcp`: `request_human` returns the link (URL elicitation where declared), the form path and its approval-state codec are removed; `check_requests` reports the new states.
- `apps/web`: the approval route and page, the server action for Send and Don't send, session check against the request's principal.
- `apps/worker`: expiry of unanswered approvals; delivery starts only from `sent`.
- `packages/ui`: the page's components on the provisional foundations used by the M1 sign-in screens until `m2-design-foundations` lands.
- `tests/`: contract and adversarial cases for the link, e2e for the page on previews.
- Docs: PRD §6 request-card paragraph (implementation sentence), ADR 0003 item 6 (the MCP App card is no longer the plan), `docs/runbooks/mcp-setup.md`.

## How the product owner validates (Gate 2)

On the change's preview, signed in with your allow-listed address: from claude.ai and from Claude Code, ask for a question to a simulated participant; open the link the client shows; edit the question, see "Restore agent draft", send; ask the agent to check it. Repeat with "Don't send", and once leaving the link to expire. Open someone else's link: refused. Open the page on a phone.

## Decisions needed at Gate 1

1. **Attachments in this change or the next.** Recommended: next change. Manifests with attachments stay refused here; this change builds the page so a file list slots in. Attachments need uploads, storage rules, scanning and a viewer on the participant side too; bundling them doubles the change.
2. **What the agent sees before approval.** Recommended: a request id at once, status `awaiting_approval`, and the link; `check_requests` follows it. Alternative: no id until Send (the approval has its own id); simpler lifecycle, but the agent tracks two kinds of id.
3. **How long a link stays valid.** Recommended: 24 hours, or less when the request's own expiry minus the participant's latency promise comes sooner; after that the request becomes not sent. Alternative: 15 minutes, as today's approval state.
4. **Telling the principal when they are not in the chat.** Recommended: not in this change (the link is in the chat; the notification email with deep link stays in M5). Alternative: an email with the link now, which pulls SES production sending and its sign-in limit (issue #63) into this change.
5. **Remove the MCP form entirely.** Recommended: yes, one approval path for every client. Alternative: keep the form as a fallback for clients that cannot open links; none known.
