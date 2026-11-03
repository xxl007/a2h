# Design

## Context

See proposal.md for why. Current state that shapes the approach:

- `request_human` (`apps/mcp/src/tools/request-human.ts`) validates the manifest with the pure `validateManifest` of `packages/protocol`, then asks for approval with a 2026-07-28 `input_required` form carrying a signed, fifteen-minute approval state; on accept it calls `createRequest` (`packages/db/src/queries/mcp.ts`), which inserts the request as `sent` with its first event row in one transaction.
- There is no ledger yet (M4): `held_minor` is the gross bid reported, not money moved.
- The worker's dispatcher looks for due `sent` requests every five seconds and delivers them; expiry runs every minute. Neither needs a queue message from the web app: a row in `sent` is enough.
- `apps/web` reaches Aurora through the Data API (ADR 0001 amendment 2), has Better Auth sessions, the allow-list re-check on every signed-in request (M1 cold review), and the sign-in, consent and connected-apps screens on provisional foundations (M1 design.md S0).
- The installed MCP SDK (`@modelcontextprotocol/server` 2.4.0) carries URL-mode elicitation (`mode: "url"`, `url`, `elicitationId`, `notifications/elicitation/complete`, `UrlElicitationRequiredError`).

## Goals / Non-Goals

**Goals:**
- One approval path for every client; the page is the single place a request leaves `awaiting_approval` for `sent`.
- Send re-runs the same validation as `request_human`, in the same order, from the same pure function.
- The MCP service keeps no session state (stateless Streamable HTTP stays true).

**Non-Goals:**
- Attachments, voice, video, a principal dashboard, notification email (proposal decisions 1 and 4).
- Real money movement: holds stay reported amounts until M4.
- Final visual design: the page uses the provisional foundations; `m2-design-foundations` restyles it.

## Decisions

### D1. The request row exists from `request_human`, in `awaiting_approval`
`request_human` inserts the request with status `awaiting_approval`, the validated manifest, the agent's question as `agent_draft`, `approval_token_hash`, `approval_expires_at`, and its first event row, in one transaction. Send updates the question (if edited) and moves it to `sent` with an event row; Don't send and link expiry move it to `not_sent` with a reason.
Why over a separate drafts table: one id from the first call (proposal decision 2), one lifecycle, `check_requests` and the worker read one table. Alternative kept in the proposal: no id until Send.
The worker's delivery query already selects `sent` only; a test pins that `awaiting_approval` rows are never delivered or counted against the participant's interruption budget.

### D2. The link
`https://<web host>/approve/<request id>?t=<token>`, token 32 random bytes base64url, stored as SHA-256. The token alone grants nothing: the page also requires the signed-in principal of the request (spec `platform/approval-page`). Logs record the request id and principal id, never the query string; CloudFront and ALB access logs stay off for these paths, as for the sign-in link.
Expiry (proposal decision 3): the earlier of 24 hours after creation and the request's own expiry minus the participant's latency promise; at least 15 minutes, otherwise `request_human` refuses with the existing latency refusal.
Alternative rejected: a token in the URL fragment, read by script and posted: the page must work with JavaScript off for the read-only states, and the server action needs the token anyway.

### D3. How the client is told
If the client declared `elicitation.url`, `request_human` answers with an `input_required` URL elicitation (`mode: "url"`, the link, `elicitationId` = request id, a one-sentence message). On the retry: accept or no answer → result `awaiting_approval` with the link; decline or cancel → the request moves to `not_sent` (`declined`) and the result says so. Otherwise the first response is already the `awaiting_approval` result, whose text tells the agent to show the link and that `check_requests` will report the outcome.
The server does not wait for the page: the URL elicitation's accept only means the principal agreed to open the link. When Send happens on the page, nothing is pushed to the client in this change (stateless server, no held stream); the agent checks. `notifications/elicitation/complete` is a later improvement once a held subscription exists.
Spike first (task 1): which of claude.ai and Claude Code declare `elicitation.url` and how each shows it; the design holds either way, only the wording of the result text depends on it.

### D4. Send is a server action in `apps/web`
In one Data API transaction: select the request `FOR UPDATE`; check `awaiting_approval`, token hash, expiry, principal = session principal; load the participant's current rules, the principal's policy and today's counts; run `validateManifest` from `packages/protocol` on the manifest with the approved question; on success update question and status with the event row; on failure leave the row and return the `ProtocolError` category for the page. Don't send is the same transaction without validation.
Why in the web app and not through an MCP or internal API: the page's session is the authority for the decision, and the web app already reaches the database; an internal call from web to the MCP service would add a trust boundary for no gain. The validation code is shared because it is pure (`packages/protocol`); the loading of rules, policy and counts moves from `apps/mcp` into `packages/db` queries both apps call, so the two paths cannot drift.

### D5. The MCP form path is removed
The `input_required` form, `approvalMessage`, the approval-state codec and its replay table go (proposal decision 5). The tests that cover them are replaced by the link scenarios. The `Client without forms` and `Client on an older revision` refusals disappear because the link works in any client.

### D6. Expiry
The worker's minute job also moves `awaiting_approval` rows past `approval_expires_at` to `not_sent` (`expired`). The page checks expiry itself on open and on Send, so a late job never lets a stale link send.

### D7. Page rendering and data
Server-rendered route `/approve/[id]` in `apps/web` (App Router), no client data fetching; the question editor and "Restore agent draft" are the only client-side behaviour, and the page degrades to a plain textarea and two submit buttons with JavaScript off. The expiry is rendered on the server in UTC with its offset and replaced in the browser with the viewer's time zone (spec "Time zone"); the principal's stored time zone arrives with the dashboard.

## Risks / Trade-offs

- [The agent forgets to show the link in clients without URL elicitation] → the result text leads with the link and an instruction to show it; the tool description says so; the contract test checks the text.
- [Principal approves hours later and the participant's quiet hours or interruption budget changed] → Send re-validates (D4); delivery re-validates again (existing requirement).
- [Two tabs press Send] → `FOR UPDATE` plus the status check; the second sees "already decided" (spec "Decision replayed").
- [Link leaks through a shared screen] → token is useless without the principal's session (D2); allow-list re-check applies.
- [Unapproved rows pile up] → expiry after at most 24 hours; rows are small; erasure policy (PRD §11) applies as for requests.
- [Breaking change for agents that expect `sent` from `request_human`] → the three tool descriptions and the result text state the new flow; only our own clients exist today.

## Migration Plan

Forward-only migration adding `awaiting_approval` and `not_sent` to the status set and the approval columns; existing rows are all `sent` or later and are untouched. Deploy order is irrelevant within one stage deploy (web, mcp and worker ship together). Rollback is a redeploy of the previous version; rows in `awaiting_approval` would then never be delivered and expire unseen, which is safe.

## Screens

Written by Design after Gate 1 (approval page and its states, copy, tokens used, accessibility notes), on the provisional foundations of the M1 screens.
