# Spec Delta

## ADDED Requirements

### Requirement: Approval happens on the hosted approval page
After validation passes, `request_human` SHALL record the request as `awaiting_approval`, hold no money, deliver nothing, and return within one second with the request id, an approval link and the link's expiry. The request SHALL be sent only when its principal chooses Send on the approval page.

#### Scenario: Link returned
- **WHEN** a valid manifest is submitted
- **THEN** the result has status `awaiting_approval`, a request id of the form `A2H-xxxx`, an `https` approval link on the stage's web host and the link's expiry, arrives within one second, and no hold or delivery exists for the request

#### Scenario: Send on the page
- **WHEN** the principal opens the link and chooses Send with the question unchanged
- **THEN** the request becomes `sent` with the gross bid held, and delivery starts outside the request

#### Scenario: Don't send on the page
- **WHEN** the principal chooses Don't send
- **THEN** the request becomes `not_sent` with reason `declined`, nothing is held or delivered, and the participant never learns it existed

#### Scenario: Link expires unused
- **WHEN** the link's expiry passes with no decision
- **THEN** the request becomes `not_sent` with reason `expired`, and opening the link shows that it expired

### Requirement: The link is offered the way the client can show it
Where the client declares URL elicitation, `request_human` SHALL offer the approval link as an MCP URL elicitation with a one-sentence message; everywhere else the link SHALL be in the tool result text with a sentence telling the agent to show it to the principal. No client SHALL be refused for lacking forms or for its protocol revision.

#### Scenario: Client with URL elicitation
- **WHEN** the client declares URL elicitation
- **THEN** the call asks the client to open the approval link through URL elicitation, and the eventual result carries the same request id and link

#### Scenario: Principal refuses to open the link
- **WHEN** the client asks through URL elicitation and the principal declines or dismisses the prompt
- **THEN** the request becomes `not_sent` with reason `declined`, the result says so with the request id, and nothing is held or delivered

#### Scenario: Client without URL elicitation
- **WHEN** the client declares no URL elicitation, or negotiated a revision before 2026-07-28
- **THEN** the result text carries the approval link and the instruction to show it, and the request is `awaiting_approval`

### Requirement: The link is single-use and bound to its principal
An approval link SHALL carry an unguessable token stored only as a hash, SHALL work only for the principal who made the request while signed in, and SHALL accept one decision.

#### Scenario: Another principal opens the link
- **WHEN** a signed-in principal opens a link for another principal's request
- **THEN** the page shows nothing about the request, offers no action, and the request is unchanged

#### Scenario: Decision replayed
- **WHEN** Send or Don't send is submitted for a request that is no longer `awaiting_approval`
- **THEN** nothing changes, no second hold exists, and the page shows the decision already taken

#### Scenario: Forged token
- **WHEN** a link with a token the server did not issue is opened
- **THEN** the page shows the same response as for an expired link and reveals no request

## MODIFIED Requirements

### Requirement: Approval covers the validated manifest
The request sent on approval SHALL be the validated manifest with the approved text; on Send the platform SHALL validate the approved text, the participant's rules, the budget, the throttle and the principal again, and if any check fails the request SHALL stay `awaiting_approval`, nothing SHALL be held, and the page SHALL say what to change.

#### Scenario: Edit turns the question into a push-poll
- **WHEN** the edited text is persuasion disguised as a question
- **THEN** Send fails with `forbidden_content`, nothing is held or delivered, and the request stays `awaiting_approval` until a valid Send, Don't send or expiry

#### Scenario: Accept after editing
- **WHEN** the principal edits the question on the page and chooses Send
- **THEN** the request is sent with a question byte-identical to the edited text

#### Scenario: Budget spent meanwhile
- **WHEN** other requests used the principal's remaining budget between `request_human` and Send
- **THEN** Send fails with `over_budget`, nothing is held, and the page says so

### Requirement: Fast return, delivery later
`request_human` SHALL return `request_id`, `status: "awaiting_approval"`, the approval link and its expiry within one second; on Send the hold SHALL be placed and delivery SHALL happen outside the request.

#### Scenario: Return under a second
- **WHEN** a valid manifest is submitted
- **THEN** the result arrives within one second with a request id of the form `A2H-xxxx`, status `awaiting_approval`, the approval link and its expiry, and no hold

## REMOVED Requirements

### Requirement: Approval shows the exact wording
**Reason**: Owner decision 7 (2026-11-01): the host-drawn MCP form is unreadable in hosted clients; approval moves to the hosted approval page (requirement "Approval happens on the hosted approval page" here and capability `platform/approval-page`), which shows the exact wording and every field the participant receives.
**Migration**: Clients stop receiving `input_required` for approval and its approval state; they receive `awaiting_approval` with a link. Scenarios move: "Accept after editing" to "Approval covers the validated manifest"; "Options shown with the question", "Decline", "Dismissed" to `platform/approval-page` and "Don't send on the page" / "Link expires unused"; the approval-state scenarios to "The link is single-use and bound to its principal"; "Client without forms" and "Client on an older revision" to "The link is offered the way the client can show it".
