# Spec Delta

## Purpose

Nothing leaves a principal that the principal did not approve: `request_human` validates the manifest on the server, then shows the principal the exact wording and delivers nothing until they accept it.

## ADDED Requirements

### Requirement: Manifest validation runs before anything else
`request_human` SHALL validate the manifest server side in this order: schema, principal, forbidden content, participant rules, budget, throttle; SHALL stop at the first failure; and SHALL return an error with a `code`, a `stage`, a `retryable` flag and a category-only `detail`, never the participant's rules.

#### Scenario: Bid below reserve
- **WHEN** the bid is below the participant's gross reserve for that request type
- **THEN** the call fails with code `outside_participant_rules`, no approval is shown, nothing is created, and the detail does not state the reserve

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

### Requirement: Approval shows the exact wording
After validation passes, `request_human` SHALL ask the principal for approval with exactly one pre-filled text field holding the question, a message stating the gross bid, the format, the expiry and the data terms, and a primary action worded "Send · hold €N"; it SHALL create a request only on accept.

#### Scenario: Accept after editing
- **WHEN** the principal edits the pre-filled question and accepts
- **THEN** one request is created whose question is byte-identical to the edited text

#### Scenario: Decline
- **WHEN** the principal declines
- **THEN** nothing is created, the result says the request was not sent, and `check_requests` does not know any id for it

#### Scenario: Dismissed
- **WHEN** the principal dismisses the approval without choosing
- **THEN** the outcome is the same as a decline

#### Scenario: Forged or expired approval state
- **WHEN** the retried call carries approval state that the server did not issue, that was altered, or that is older than fifteen minutes
- **THEN** the call is refused before any handler runs with JSON-RPC error `-32602` and reason `invalid_request_state`, and nothing is created

#### Scenario: Approval state replayed with changed arguments
- **WHEN** the retried call carries approval state the server issued, but for a manifest whose hash differs from the retried arguments
- **THEN** the call is refused with code `conflict` and nothing is created

#### Scenario: Client on an older revision
- **WHEN** `request_human` is called over a connection negotiated on a revision earlier than 2026-07-28
- **THEN** the call returns an error result whose text says that approval needs the 2026-07-28 revision and how to enable it in Claude Code, and nothing is created

### Requirement: Approval covers the validated manifest
The request created on accept SHALL be the validated manifest with the approved text; if the edited text fails validation, the call SHALL fail like any other validation failure and create nothing.

#### Scenario: Edit turns the question into a push-poll
- **WHEN** the edited text is persuasion disguised as a question
- **THEN** the call fails with `forbidden_content` and no request exists

### Requirement: Fast return, delivery later
On accept, `request_human` SHALL return `request_id`, `eta`, `status: "sent"` and `held_minor` (gross) within one second, and delivery SHALL happen outside the call.

#### Scenario: Return under a second
- **WHEN** the principal accepts
- **THEN** the result arrives within one second with a request id of the form `A2H-xxxx`, an ETA, status `sent` and the held amount equal to the gross bid

### Requirement: Every request carries its principal
Every created request SHALL record the accountable principal identity of the connection; in this change that identity is the stage's development principal, and a request from a different principal SHALL be invisible to it.

#### Scenario: Principal recorded
- **WHEN** a request is created
- **THEN** it carries the principal id, and `check_requests` from another principal reports `not_found` for that id

### Requirement: Blocked manifests are counted without content
Every validation failure at the rules stage SHALL be recorded with the participant id, the principal id, the stage, the code and the time, and SHALL NOT record the question text or any personal data.

#### Scenario: Blocked row
- **WHEN** a manifest is blocked by the participant's rules
- **THEN** one blocked-manifest row exists with participant id, principal id, stage, code and time, and no column holds the question
