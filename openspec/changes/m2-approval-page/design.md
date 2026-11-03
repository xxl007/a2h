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
If the client declared `elicitation.url`, `request_human` answers with an `input_required` URL elicitation (`mode: "url"`, the link, a one-sentence message). The 2026-07-28 URL shape has no `elicitationId` (spike, task 1.1): the request id travels in the signed `requestState` of the `input_required` result, as the M1 approval state did. On the retry: accept or no answer → result `awaiting_approval` with the link; decline or cancel → the request moves to `not_sent` (`declined`) and the result says so. Otherwise the first response is already the `awaiting_approval` result, whose text tells the agent to show the link and that `check_requests` will report the outcome.
The server does not wait for the page: the URL elicitation's accept only means the principal agreed to open the link. When Send happens on the page, nothing is pushed to the client in this change (stateless server, no held stream); the agent checks. `notifications/elicitation/complete` is a later improvement once a held subscription exists.
Spike first (task 1): which of claude.ai and Claude Code declare `elicitation.url` and how each shows it; the design holds either way, only the wording of the result text depends on it.

### D4. Send is a server action in `apps/web`
In one Data API transaction: select the request `FOR UPDATE`; check `awaiting_approval`, token hash, expiry, principal = session principal; load the participant's current rules, the principal's policy and today's counts; run `validateManifest` from `packages/protocol` on the manifest with the approved question; on success update question and status with the event row; on failure leave the row and return the `ProtocolError` category for the page. Don't send is the same transaction without validation.
Why in the web app and not through an MCP or internal API: the page's session is the authority for the decision, and the web app already reaches the database; an internal call from web to the MCP service would add a trust boundary for no gain. The principal's daily request limit counts only requests that were sent (PM decision 2026-11-03, from group 2): counting the request being decided would make Send fail at the limit by one, and an unapproved request reaches nobody; unapproved `request_human` calls are bounded by the per-principal call limits (spec `platform/hosted-endpoint`). The validation code is shared because it is pure (`packages/protocol`); the loading of rules, policy and counts moves from `apps/mcp` into `packages/db` queries both apps call, so the two paths cannot drift.

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

Written by Design after Gate 1 (task 4.1). One page, `/approve/[id]`, in `apps/web`, built from `packages/ui` (`@a2h/ui`); the web dev composes it and owns the route, session and token checks, server actions and data (D4, D7). Every state below exists as a component state and a Storybook story ("Screens/Approval …"); the copy is `copy.approval` in `packages/ui/src/screens/copy.ts`, and the two change together.

**Static HTML spec per state:** [`screens/index.html`](screens/index.html), one self-contained file per state, exported from the Storybook build by `packages/ui/scripts/export-screens.mjs` (390 px reference width; light or dark follows the system). They are not interactive. The interactive version is the story "Screens/Approval Interactive".

| State | Spec | Story |
|---|---|---|
| A1 Awaiting decision: paid, simulated participant | [a1-awaiting](screens/a1-awaiting.html) | Approval Awaiting |
| A1 Poll with options and scale, free lane, delivery deferred | [a1b-poll-free-deferred](screens/a1b-poll-free-deferred.html) | Approval Poll Free Deferred |
| A1 Participant not simulated, production (no stage line) | [a1c-real-participant](screens/a1c-real-participant.html) | Approval Real Participant |
| A2 Edited, "Restore agent draft" | [a2-edited](screens/a2-edited.html) | Approval Edited |
| A2 Question emptied | [a2b-empty](screens/a2b-empty.html) | Approval Empty |
| A2 Over the limit | [a2c-over-limit](screens/a2c-over-limit.html) | Approval Over Limit |
| A3 Sending | [a3-sending](screens/a3-sending.html) | Approval Sending |
| A3 Cancelling (Don't send pressed) | [a3b-cancelling](screens/a3b-cancelling.html) | Approval Cancelling |
| A4 Validation failed after an edit: content rule | [a4-refused-content](screens/a4-refused-content.html) | Approval Refused Content |
| A4 Validation failed: no longer fits their rules | [a4b-refused-rules](screens/a4b-refused-rules.html) | Approval Refused Rules |
| A4 Validation failed: over budget | [a4c-refused-budget](screens/a4c-refused-budget.html) | Approval Refused Budget |
| A5 Error: choice not recorded | [a5-error](screens/a5-error.html) | Approval Error |
| A6 Offline | [a6-offline](screens/a6-offline.html) | Approval Offline |
| A7 Sent | [a7-sent](screens/a7-sent.html) | Approval Sent |
| A8 Already decided: sent | [a8-already-sent](screens/a8-already-sent.html) | Approval Already Sent |
| A8 Already decided: not sent | [a8b-already-not-sent](screens/a8b-already-not-sent.html) | Approval Already Not Sent |
| A9 Not sent | [a9-not-sent](screens/a9-not-sent.html) | Approval Not Sent |
| A10 Link expired (and a forged link) | [a10-expired](screens/a10-expired.html) | Approval Expired |
| A11 Wrong principal | [a11-wrong-principal](screens/a11-wrong-principal.html) | Approval Wrong Principal |
| A12 Signed out: sign in, then back | [a12-sign-in](screens/a12-sign-in.html) | Approval Sign In |

Regenerate after a change to the components: `pnpm --filter @a2h/ui build-storybook && node packages/ui/scripts/export-screens.mjs`.

### A0. Foundations, components, data

**Foundations.** The provisional semantic tier of M1 (M1 design.md S0), unchanged: every role resolves to a CSS system colour or a `color-mix` of them, no hex or OKLCH value exists in `packages/ui`, and `m2-design-foundations` later replaces the right-hand sides of `tokens.css` without touching this page. System font stack (skill §2.5: the request path never loads a web font). No new token and no new colour pair: the page uses the roles M1 already measured.

**Roles used:** `--surface` (page), `--surface-2` (question field, question as sent), `--text` (all reading text, the question itself, fact values), `--text-muted` (fact terms, notes, count, field description, request id), `--border` (fact rows, header), `--border-strong` (field and ghost button edges), `--accent` (primary button, ghost button text, "Restore agent draft"), `--on-accent`, `--focus`, `--pending-*` (pill "Not sent yet"), `--success-*` (pill "Sent"), `--neutral-*` (pill "Not sent", offline notice, stage line), `--danger-*` (refusal and error notices, over-limit count and field error). Spacing `--space-1…6`, radius `--radius-md` (field, buttons), `--radius-lg` (notices, question as sent), `--radius-pill`; `--target-min` 44 px; `--measure` 62ch; type `--text-xs…xl`; `--font-mono` for the request id and handle; tabular numerals on money, count and times.

**Colour roles (skill §3, ADR 0003 D3).** The question is plain text on the input surface: no tint, no accent border, whoever wrote it. Its origin is said in words: the lead ("Your agent wants to send it to …") says the agent drafted it, and the "Restore agent draft" control appears once the text differs. While the text is unchanged there is no marker under the field (see "Prototype and PRD"). Every control takes the one accent; statuses are pills and notices with words. No second hue.

**New components in `packages/ui`** (task 4.2; stories under "Components/Approval"):

| Component | What it is |
|---|---|
| `QuestionEditor` | Native `<textarea>` with visible `<label>`, description, count and limit, "Restore agent draft" once edited, field error. Controlled (`value`, `onChange`) or not. `questionStatus(value, agentDraft, max)` is the pure rule for count, over, blank and edited; Send availability comes from it. |
| `FactList`, `Fact`, `FactNote`, `Mono`, `OptionList` | `<dl>` of term and value rows, stacked under 600 px, 150 px term column above; notes in `--text-muted`; poll options as a numbered `<ol>`. |
| `DecisionBar` | The two submit buttons (`name="decision"`, values `send` and `dont_send`), pending labels, the note line beneath. |
| `StatusPill` | Status triplet with words, sentence case. |
| `LocalTime`, `formatDateTime` | A `<time>` rendered in UTC on the server and in the viewer's zone after hydration (spec "Time zone"). |
| `ApprovalScreen` | The page: `state`, `request`, `question`, `decidedAt`, `refusal`, `reference`, `action`, `email`, `signOutAction`, `stageName`. |

`SignInScreen` gains `nextPurpose: "connect" | "approve"` (A12). `Button` gains `aria-describedby`.

**Data the web dev passes** (`ApprovalRequest`, all formatted at the edge, never computed in the UI):
- `id` ("A2H-7f3c"); `participant` `{ label, handle, simulated }` (the display label already ends in "(simulated)" for simulated participants, schema check);
- `intent`, `format` (protocol enum values; the words are copy), `options` (manifest order, labels verbatim), `scale`;
- `money`: paid `{ hold: "€35.00", feeRate: "15%", fee: "€5.25", net: "€29.75" }`, fee and net at the full bid from `packages/protocol` `fee()` and `net()` with the stage's `FEE_RATE`; free `{ freeLane }`;
- `expiresAt`, `approvalExpiresAt`, `deliverAt` (only when deferred), all ISO with offset;
- `dataTerms` `{ attribution, training }` (storage is always the principal's workspace in v1);
- `agentDraft` (byte for byte), `questionMaxLength` (`QUESTION_MAX_LENGTH`).
- For outcomes: `decidedAt` (ISO) and, on a refused Send, `refusal` = the `ProtocolError` code, or the content class (`persuasion_disguised`, `third_party_personal_data`, `labour_disguised`) when Send failed with `forbidden_content` and the class is known. The class is not in `ProtocolError` today: if protocol-dev cannot pass it, the web dev passes `forbidden_content` and the generic wording applies.

### A1. Awaiting decision

```html
<AuthShell width=wide account={email, signOutAction} [stageName]>
  <p class="reference"><Mono>Request {id}</Mono> <StatusPill pending>Not sent yet</StatusPill></p>
  <h1>Review this question before it is sent</h1>
  <p class="lead">Your agent wants to send it to {participant label}. Nothing is sent and nothing is held until you choose.</p>
  [notices: A4 refused, A5 error, A6 offline]
  <form method=post action={decide}>
    <QuestionEditor name=question value agentDraft maxLength=2000/>          <!-- A2 -->
    <!-- SLOT "attachments" (next change): <section aria-labelledby> "Files they will consult" -->
    <section aria-labelledby="request-details">
      <h2 id="request-details">Request details</h2>
      <FactList> To · Request type · Answer format · Hold · Expires · Their answer · Delivery </FactList>
    </section>
    <DecisionBar send="Send · hold €35.00" | "Send"  dontSend="Don't send"
                 note="Nothing is sent and nothing is held until you choose. This link works until {time}."/>
  </form>
</AuthShell>
```

Order follows the participant's reading: who it goes to (lead), the words, what they will consult, then the terms, then the decision. The question is first among the controls because it is the one thing the principal must judge (PRD §6).

**Fact list, in this order and wording** (spec "The page shows what the participant will receive"):

| Term | Value | Secondary line (`--text-muted`) |
|---|---|---|
| To | display label, e.g. **Margaret Vale (simulated)**; the handle in mono, `sim-mv-7f3c` | simulated only: **Simulated participant: no person will be asked. A script answers on this test stage.** |
| Request type | Observation · Verification · Judgment · Opinion · Estimate · Knowledge · Authorisation · Action · Referral | |
| Answer format | One written answer · One option, picked from a list · A short form · A file · A voice note | with options: **They pick one of these options, shown to them in this order:** then a numbered list of the labels verbatim (ids never shown); with a scale: **They answer on a scale from {min} to {max}.** (in `--text`) |
| Hold | paid: **€35.00, held when you send** (strong, tabular) · free: **Nothing is held and nothing is charged: this is their free lane for questions about their own publications.** / **… about facts about themselves.** | paid: **You pay what clears, never more. If it expires unanswered, nothing is charged.** then **Includes the A2H fee (15%): at your full bid, €29.75 goes to them and €5.25 to A2H.** |
| Expires | **12:20 on 4 Nov 2026 (UTC+01:00)** | paid: **If they have not answered by then, the request ends and the hold is released.** · free: **If they have not answered by then, the request ends. Nothing is charged.** |
| Their answer | **Stored in your workspace, not attributed to them, never used for training.** Variants: "attributed to them"; "used for training only if they opt in" | |
| Delivery | **As soon as you send.** or **At 08:00 on 4 Nov 2026 (UTC+01:00), the earliest their rules allow.** | |

The fee breakdown is visible, not behind a toggle: the page has room, and skill §6 asks that both figures be one step away at most. Gross on the hold line (the principal's figure), net named as what goes to them (ADR 0002 D4). The breakdown is at the full bid because the clearing price is not known yet; "you pay what clears" covers the rest. The participant's reserve, quiet hours, daily limit and other rules are never stated (the delivery time is the only trace of them, as in M1).

**Times** (spec "Time zone"): "HH:MM on D Mon YYYY (UTC±HH:MM)", 24-hour clock, "(UTC)" for offset zero, never an ISO string, never a zone name the page cannot know. Server-rendered in UTC, replaced after hydration with the browser's zone (`Intl` resolved zone), so JavaScript-off readers see a correct UTC time with its offset. No relative "in 12 h": the page can stay open, and a stale relative figure is worse than none.

**Decision bar** (spec "Two actions, money on the send action"): primary **Send · hold €35.00** (paid; `money()` format with cents, as the spec scenario) or **Send** (free lane), ghost **Don't send**. Neither is focused, pre-selected or the form's default; the form holds no single-line input, so the browser has no implicit submission, and Enter in the question inserts a line break (native textarea; no key handler on the page, Ctrl/Cmd+Enter does nothing either). Under 600 px both are full width, Send on top; from 600 px they sit side by side, Send first on the left, so the visual order matches the Tab order. (M1 consent puts the primary on the right with `row-reverse`; not repeated here because the reversed order makes Tab and sight disagree. Consent can follow when the foundations change restyles it.) Note under the buttons: **Nothing is sent and nothing is held until you choose. This link works until 10:20 on 4 Nov 2026 (UTC+01:00).** Not sticky: a fixed bar would cover the question while the phone keyboard is open.

**Attachments slot (next change).** Between the question and "Request details", a `<section aria-labelledby>` headed **Files they will consult**: one row per file (name, size or length, "opens here", a remove control for the principal), in the order the participant will see them, under the question because the participant reads them with it. The fact list stays as it is. Nothing of it is rendered in this change; the place is marked in `ApprovalScreen.tsx`. Manifests with attachments are still refused at `request_human` (proposal decision 1).

### A2. Editing (same page; spec "The question is editable in place")

- **Unchanged**: under the field, only the count on the right, **414 / 2000** (`--text-muted`, tabular; read to screen readers as "414 of 2000 characters"). No marker on the left: a coloured "Agent draft" that does nothing reads as a link.
- **Edited** (text differs from the draft by even one byte): the control **Restore agent draft** appears on the left (accent, underlined, 44 px tall). It brings back the agent's text exactly, disappears, returns focus to the field and announces **Agent draft restored.** (polite). There is no edit mode and nothing to confirm.
- **Count** is the protocol's own unit (UTF-16 code units, what `z.string().max(2000)` counts), so the page and the server never disagree about the limit.
- **Over the limit**: the count reads **2043 / 2000 · 43 over the limit** in `--danger-text`; under it **Error: Shorten the question by 43 characters to send it.** (polite live region); the field is marked invalid (2 px `--danger-border`); Send is unavailable and points at the error with `aria-describedby`. Don't send stays available.
- **Blank** (empty or whitespace only): **Error: Write a question to send it.**; Send unavailable.
- Typing is never blocked at the limit (no `maxlength`): a pasted text is kept whole so the principal can cut it down, rather than silently truncated.
- **JavaScript off**: the field is a plain textarea that posts; the count is the server's value at render; "Restore agent draft" is not shown (it needs script). Send and Don't send post the form.

### A3. Sending and cancelling

After **Send**: the button reads **Sending…** and is busy; Don't send is disabled; the question is read-only (muted). After **Don't send**: that button reads **Cancelling…**; Send is disabled. No spinner-only state; focus stays on the pressed button. No optimistic outcome: the page moves to A7 or A9 only on the server's answer.

### A4. Validation failed after an edit (spec scenario; `request-approval` "Approval covers the validated manifest")

The page keeps the edited text, both actions stay available, and a `danger` notice above the form names the category, with `role=alert`; focus moves to the notice. Every notice ends with **Nothing was sent and nothing is held.**

| Refusal | Title | Body |
|---|---|---|
| `persuasion_disguised` | This wording can't be sent | The question reads as persuasion rather than a question, and A2H does not deliver that. Reword it as a neutral question, or restore the agent draft. |
| `third_party_personal_data` | This wording can't be sent | The question asks for personal details about someone other than the participant, and A2H does not deliver that. Remove that part, or restore the agent draft. |
| `labour_disguised` | This wording can't be sent | The question asks for a piece of work rather than an answer, and A2H does not deliver that. Narrow it to a question, or restore the agent draft. |
| `forbidden_content` (class unknown) | This wording can't be sent | The edited question breaks an A2H content rule. Change the wording, or restore the agent draft. |
| `outside_participant_rules` | It no longer fits their rules | Since your agent drafted it, this request has stopped fitting what the participant accepts. Choose Don't send and ask your agent to find someone else. |
| `over_budget` | Over your budget | Other requests have used your remaining budget since this one was drafted. Choose Don't send, or try again once budget is free. |
| `over_cap` | Over your limit for one request | The bid is above the most you allow for a single request. Choose Don't send and ask your agent for a lower bid. |
| `rate_limited` | Too many requests right now | Try Send again in a few minutes. This page keeps your edits. |
| `principal_not_verified_for_lane` | Your account can't send paid requests yet | Paid requests need a verified identity on your account. Choose Don't send, or ask your agent for a free-lane request. |
| `schema_invalid` | The question can't be sent as it is | Check that it is not empty and fits the limit, then try again. |

Which rule of the participant failed is never said (it would disclose their rules). `outside_participant_rules` does not say whose change caused it, because an edit cannot change the type or the bid and the cause is therefore their rules or their daily count.

### A5. Error (the server action failed or timed out)

`danger` notice, `role=alert`, focus moves to it: **Your choice was not recorded** / "Nothing was sent and nothing is held. Try again." + **Reference {request id of the HTTP call}** (mono). Edits kept, both actions available. A retry after a Send that did in fact go through lands on A8 (spec "Decision replayed").

### A6. Offline

When the browser reports no connection at submit, or `navigator.onLine` is false: `neutral` notice, `role=status`: **You're offline** / "Your edits stay on this page. Nothing is sent until you choose again with a connection." Nothing is queued: a decision is never sent later on the principal's behalf (as M1 consent). Edits stay in the field (not persisted across a reload in this change).

### A7. Sent

```html
<p class="reference"><Mono>Request {id}</Mono> <StatusPill success>Sent</StatusPill></p>
<h1 tabindex=-1>Question sent</h1>                      <!-- focused after the action -->
<p class="lead">Sent to {participant label} at {time}.</p>
<p><strong>€35.00</strong> is held. You pay what clears, never more.</p>   <!-- free: "Nothing is held and nothing is charged." -->
<p>Your agent can follow it: ask it to check on this request. You can close this page.</p>
<section><h2>The question as sent</h2><p class="question-as-sent">{question, line breaks kept}</p></section>
```

No action. The question as sent is plain text on `--surface-2` (pattern 4e's quote block), so the principal can see what left. Document title **Question sent · A2H**. Delivery is not restated: it is the worker's job from here, and a deferred time could be stale by the time the page is re-read.

### A8. Already decided (spec "Already decided", `request-approval` "Decision replayed")

Opened again after a decision, or a second tab pressing Send after the first:
- **Sent** (whatever happened since: accepted, answered, expired after sending): as A7, h1 **This question was already sent**, plus **Nothing more can be decided on this page.** No action.
- **Not sent by the principal**: pill **Not sent**, h1 **This request was not sent**, "You chose not to send it at {time}. Nothing was sent and nothing is held." / "Nothing more can be decided on this page." / "To ask again, ask your agent to draft a new request." No action.
- **Not sent because the link expired**: A10.

### A9. Not sent (after Don't send)

Pill **Not sent** (neutral); h1 **Not sent** (focused); "Nothing was sent and nothing is held. {participant label} was not contacted and will not learn about this request." / "Your agent will see that you chose not to send it. You can close this page." No action. Document title **Not sent · A2H**.

### A10. Link expired, and a forged or unknown link

h1 **This approval link has expired**; "Nothing was sent and nothing is held. Approval links stop working after at most 24 hours." / "If you still want to ask, ask your agent to draft the request again." No request id, no participant, no amount, no action: the same markup for an expired link, a request already expired to `not_sent`, a token the server did not issue and an unknown id (spec "Forged token"). Document title **Approval link expired · A2H**.

### A11. Wrong principal (spec "Wrong principal")

h1 **This link belongs to another account**; "You're signed in as **{own address}**, which did not make this request, so nothing about it is shown here." / "Sign out, then open the link again and sign in with the account your agent uses." Only the header's Sign out. No id, no question, participant, amount or action. Shown only when the link's token matches the request: a token that does not match shows A10, so this wording never confirms that a guessed id exists.

### A12. Signed out

No approval screen: the route redirects to `/sign-in` with the return path. The sign-in screen (M1 S2) shows the lead **Sign in to review the question your agent wants to send. We'll email you a link; open it in this browser to come back to the question.** (`SignInScreen nextPurpose="approve"`); after the magic link, the principal lands back on the same approval page (spec "Signed out"). Everything else on S2–S3 is unchanged.

For the web dev: the token must not travel in `next` through the magic-link email or the sign-in URL (D2: no query string in logs; the sign-in link is emailed). Recommended: on a signed-out hit, keep `/approve/{id}?t=…` in a short-lived HttpOnly cookie and pass `next=/approve/{id}` only; read the token back from the cookie after sign-in.

### Keyboard order and focus

Header **Sign out** → question field → **Restore agent draft** (only when edited) → **Send · hold €N** → **Don't send**. Facts contain no control. Enter in the field is a line break; Space or Enter on a focused button decides. After Restore, focus returns to the field. After a refusal or error, focus moves to the notice; after an outcome (A7, A9, and A8/A10 reached by an action), to the h1. Focus ring `2px solid var(--focus)`, offset 2 px, on every stop. No dialog, no focus trap, no skip link needed (one form, two stops before it).

### 320 px layout and reduced motion

Single column, 16 px gutters with safe-area insets; the header's account line wraps under the wordmark; fact rows stack term over value; buttons full width, both reachable without zooming; long labels, handles and option labels wrap (`overflow-wrap: anywhere`); the field grows with its content up to 70 % of the viewport (`field-sizing: content` where supported, `resize: vertical` elsewhere). Nothing scrolls horizontally (checked at 320, 390 and 1280). No animation on the page; the only motion token use is the M1 button opacity transition, under `prefers-reduced-motion: no-preference`.

### Accessibility (WCAG 2.2 AA)

- One `h1` per state; "Request details" and "The question as sent" are `h2`s; the fact list is a `<dl>` named by its heading.
- The field has a visible `<label>`; description, count and error are linked with `aria-describedby`; `aria-invalid` when blank or over; errors prefixed "Error:" and announced politely; "Agent draft restored." announced in a status region.
- Send's unavailability is explained by the error it points at; Don't send is never disabled except while Send is being recorded.
- Status is always in words (pills "Not sent yet", "Sent", "Not sent"; notice titles); who drafted the question is said in the lead, in words.
- Targets: buttons, field and Restore are at least 44 × 44 px at every width.
- Contrast: no new pair; roles as measured in M1. Axe on every story, both themes (below).
- `<time datetime>` on every time; money and counts in tabular numerals.

### Never on this page

The token, any ISO string, protocol values or underscores, the participant's reserve, quiet hours, daily count or any other rule; the participant's identity beyond the display label and handle the policy allows; another principal's anything; a model call; a third action; a pre-selected decision; an autosave that sends; the word "development".

### Prototype and PRD

- PRD §6 and the prototype collapse the secondary details into one `<details>` line. **Followed the spec instead** ("The page SHALL show … every poll option and the scale verbatim, the gross hold with its fee breakdown …"): on a page, unlike a host card, there is room, and a collapsed poll option is a fact the principal can approve without seeing. The facts are therefore always visible, below the question.
- The prototype's card heading "A2H · approve before sending" and its pill "not sent" become the request id line and the pill **Not sent yet**; the label "Your question, sent as written" becomes **Your question, sent exactly as written** (M1 wording).
- Skill §4a and the prototype show "Agent draft" in `--accent` under an unchanged question. **Dropped** on review (coordinator, 2026-11-03): a bold accent word that does nothing reads as a link, the lead already says the agent drafted the question, and the spec only asks for "Restore agent draft" once edited. The skill's §4a line should follow at archive.
- The prototype's "Effort for her" row is not shown: no effort figure exists in the manifest yet.
- Withdrawn M1 approval form: its facts and wording are reused (format phrases, fee sentence, expiry format, data terms in the second person, delivery sentence); its "Don't send first" order and the decision enum were MCP-form workarounds and are dropped.

### Open copy questions for the product owner

1. **"Hold" and the fee sentence.** "€35.00, held when you send" with "Includes the A2H fee (15%): at your full bid, €29.75 goes to them and €5.25 to A2H." Showing both figures on the page (recommended, ADR 0002 D4) or only "includes the A2H fee (15%)" with the split behind a "Show breakdown" control?
2. **Simulated note.** "Simulated participant: no person will be asked. A script answers on this test stage." Keep, or shorter: "Test participant. No one real will be asked."?
3. **Link validity line.** "This link works until 10:20 on 4 Nov 2026 (UTC+01:00)." under the buttons. Keep it visible on every view, or show it only when less than an hour is left?

### Review on Storybook (2026-11-03)

Storybook build `pnpm --filter @a2h/ui build-storybook`; 34 approval stories (12 component states, 22 screen states, including a stress case for poll labels that is not a spec state). Playwright (Chromium 1.64) over every story at 320, 390 and 1280 px, light and dark (`prefers-color-scheme` and `data-theme`), reduced motion on: axe-core 4.14 (WCAG 2.0/2.1/2.2 A and AA plus best practice), a 44 px target check and a horizontal-overflow check. Result: 204 runs, no axe violation, no control under 44 px, no horizontal overflow. Keyboard pass on "Approval Interactive" at 320 and 1280 px: Tab order as above, focus visible (2 px) at every stop; Enter and Ctrl+Enter in the field insert a line break and submit nothing; Restore brings the draft back byte for byte, disappears and returns focus to the field; Send shows "Sending…" then "Question sent" with focus on the h1; Don't send leads to "Not sent" with focus on the h1. Not run: a screen reader, browsers other than Chromium, JavaScript-off rendering, the built page in `apps/web` on the preview (task 5.4 reviews it against this section).
