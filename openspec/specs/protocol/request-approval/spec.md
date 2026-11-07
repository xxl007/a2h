# protocol/request-approval Specification

## Purpose
Nothing leaves a principal that the principal did not approve: `request_human` validates the manifest on the server, then shows the principal the exact wording and delivers nothing until they accept it.

## Requirements

### Requirement: Manifest validation runs before anything else
`request_human` SHALL validate the manifest server side in this order: schema, principal, forbidden content, participant rules, budget, throttle; SHALL stop at the first failure; and SHALL return an error with a `code`, a `stage`, a `retryable` flag and a category-only `detail`, never the participant's rules.

#### Scenario: Bid below reserve
- **WHEN** the bid is below the participant's gross reserve for that request type
- **THEN** the call fails with code `outside_participant_rules`, no approval is shown, nothing is created, and the detail does not state the reserve

#### Scenario: Shape outside this change
- **WHEN** the manifest names an audience other than a named individual, a threaded or recurring time shape, or carries attachments
- **THEN** the call is refused with `schema_invalid` naming the field and the milestone that introduces it, before anything is created

#### Scenario: Push-poll
- **WHEN** the question is persuasion disguised as a question
- **THEN** the call fails with code `forbidden_content`, stage `content`, and no approval is shown

#### Scenario: Third-party personal data
- **WHEN** the question asks for personal data about someone other than the participant
- **THEN** the call fails with code `forbidden_content`

#### Scenario: Labour disguised as a question
- **WHEN** the question asks for work rather than an answer
- **THEN** the call fails with code `forbidden_content`

#### Scenario: Quiet hours
- **WHEN** delivery would fall inside the participant's quiet hours and the expiry allows a later delivery
- **THEN** the call succeeds with a deferred delivery time and the result says so; when the expiry does not allow it, the call fails with `outside_participant_rules` and `retryable: true`

#### Scenario: Interruption budget exceeded
- **WHEN** the participant's interruptions for the day are used up
- **THEN** the call fails with `outside_participant_rules` and the block is counted for the participant

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

### Requirement: Every request carries its principal
Every created request SHALL record the accountable principal identity of the connection, which is the signed-in account the bearer token was issued to; a request from a different principal SHALL be invisible to it.

#### Scenario: Principal recorded
- **WHEN** a request is created
- **THEN** it carries the principal id of the token's account, and `check_requests` from another principal reports `not_found` for that id

#### Scenario: Principal's own policy applies
- **WHEN** a principal's manifest is validated
- **THEN** the budget, per-request cap and daily limits applied are the ones recorded for that principal (the stage default until the principal surface exists), never another principal's

### Requirement: Blocked manifests are counted without content
Every validation failure at the rules stage SHALL be recorded with the participant id, the principal id, the stage, the code and the time, and SHALL NOT record the question text or any personal data.

#### Scenario: Blocked row
- **WHEN** a manifest is blocked by the participant's rules
- **THEN** one blocked-manifest row exists with participant id, principal id, stage, code and time, and no column holds the question

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
