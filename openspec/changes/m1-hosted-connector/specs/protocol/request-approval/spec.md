# Spec Delta

## MODIFIED Requirements

### Requirement: Every request carries its principal
Every created request SHALL record the accountable principal identity of the connection, which is the signed-in account the bearer token was issued to; a request from a different principal SHALL be invisible to it.

#### Scenario: Principal recorded
- **WHEN** a request is created
- **THEN** it carries the principal id of the token's account, and `check_requests` from another principal reports `not_found` for that id

#### Scenario: Principal's own policy applies
- **WHEN** a principal's manifest is validated
- **THEN** the budget, per-request cap and daily limits applied are the ones recorded for that principal (the stage default until the principal surface exists), never another principal's

### Requirement: Approval shows the exact wording
After validation passes, `request_human` SHALL ask the principal for approval with a form of two fields and a message of at most two sentences: a pre-filled text field holding the question, byte for byte as the client sent it, and a required single-choice field `decision` with no default whose options are "Don't send" and, for accept, the wording "Send · hold €N" (or "Send" on a free lane). The gross bid, the request type, the format, the audience, the expiry in words, the data terms, the delivery timing and, verbatim, every poll option and the scale SHALL be stated in the fields' titles and descriptions, so that no fact depends on line breaks, on the client's button labels or on the client rendering the message as more than one paragraph. A request SHALL be created only when the form is accepted with "Send · hold €N" chosen.

#### Scenario: Accept after editing
- **WHEN** the principal edits the pre-filled question, chooses "Send · hold €N" and accepts
- **THEN** one request is created whose question is byte-identical to the edited text

#### Scenario: Options shown with the question
- **WHEN** the manifest carries poll options or a scale
- **THEN** the question field's description lists each option label verbatim in quotation marks and the scale, the accept option's title carries the wording "Send · hold €N", and the request created on accept holds exactly those values

#### Scenario: Readable where whitespace collapses
- **WHEN** a client renders the message as a single paragraph and labels the buttons itself
- **THEN** every fact above is still legible as a field title, a field description or an option title, and the message names no button

#### Scenario: Submitted with Don't send chosen
- **WHEN** the principal accepts the form with "Don't send" chosen
- **THEN** the outcome is the same as a decline

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

#### Scenario: Accepted approval replayed
- **WHEN** a retried call carries approval state that was already used to create a request, with the same arguments and an accept, inside the state's validity window
- **THEN** the call is refused with code `conflict`, no second request or hold is created, and the first request is unchanged

#### Scenario: Client without forms
- **WHEN** a client on the 2026-07-28 revision declares no form elicitation
- **THEN** the call returns an error result that says the approval dialog cannot be shown, and nothing is created or counted

#### Scenario: Client on an older revision
- **WHEN** `request_human` is called over a connection negotiated on a revision earlier than 2026-07-28
- **THEN** the call returns an error result whose text says that approval needs the 2026-07-28 revision and how to enable it in Claude Code, and nothing is created
