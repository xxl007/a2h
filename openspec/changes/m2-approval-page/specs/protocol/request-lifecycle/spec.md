# Spec Delta

## MODIFIED Requirements

### Requirement: Closed status set
A request's status SHALL be exactly one of `awaiting_approval`, `not_sent`, `sent`, `accepted`, `answered`, `declined`, `expired`, `cancelled`; `not_sent`, `answered`, `declined`, `expired` and `cancelled` SHALL be terminal. A request SHALL start in `awaiting_approval`, and only `awaiting_approval → sent` and `awaiting_approval → not_sent` SHALL leave it.

#### Scenario: Legal transitions
- **WHEN** the transitions `awaiting_approval → sent`, `awaiting_approval → not_sent`, `sent → accepted`, `accepted → answered`, `sent → declined`, `sent → expired`, `accepted → expired` are attempted by their actors
- **THEN** each succeeds and writes one event row

#### Scenario: Illegal transition
- **WHEN** `answered → accepted`, `declined → accepted`, `not_sent → sent` or `awaiting_approval → accepted` is attempted
- **THEN** it fails with code `invalid_transition` and the status is unchanged

#### Scenario: Idempotent replay
- **WHEN** the same transition is applied twice
- **THEN** the second application changes nothing and adds no event row

### Requirement: Actors
`awaiting_approval → sent` SHALL be caused only by the request's principal on the approval page; `awaiting_approval → not_sent` (reason `declined`) only by the request's principal, on the approval page or by refusing the URL elicitation prompt that carries the link (decline or cancel, with the signed state bound to that principal); `awaiting_approval → not_sent` (reason `expired`) only by the platform when the approval link expires; `sent → accepted`, `sent → declined` and `accepted → answered` only by the participant; `sent → expired` and `accepted → expired` only by the platform at the expiry time.

#### Scenario: Expiry by the platform
- **WHEN** a request in `sent` or `accepted` reaches its expiry time
- **THEN** its status becomes `expired` and its held amount is reported as released

#### Scenario: Approval link expiry by the platform
- **WHEN** a request in `awaiting_approval` reaches its approval link's expiry
- **THEN** its status becomes `not_sent` with reason `expired`, and no hold or delivery ever existed for it

#### Scenario: Agent cannot approve
- **WHEN** any MCP tool call tries to move a request out of `awaiting_approval`
- **THEN** no tool offers that transition, and the request is unchanged

### Requirement: check_requests reports state and answer
`check_requests` SHALL accept a request id or a filter (status, since) and SHALL return, per request: status, timestamps of each transition, the gross held amount, the approval link and its expiry while `awaiting_approval`, the reason when `not_sent`, and, when `answered`, the full signed answer envelope and the gross cleared amount; an unknown id or another principal's id SHALL yield `not_found`.

#### Scenario: Answered request
- **WHEN** `check_requests` is called for an `answered` request
- **THEN** the result carries the envelope (body, confidence, personal attestation, signed time, key id, signature) and the cleared amount

#### Scenario: Filter by status
- **WHEN** `check_requests` is called with status `sent`
- **THEN** every returned request has status `sent` and belongs to the calling principal

#### Scenario: Unknown id
- **WHEN** `check_requests` is called with an id that does not exist
- **THEN** the call fails with `not_found` and reveals nothing else

#### Scenario: Awaiting approval
- **WHEN** `check_requests` is called for a request still `awaiting_approval`
- **THEN** the result carries the approval link, its expiry and no held amount

#### Scenario: Not sent
- **WHEN** `check_requests` is called for a request the principal did not send
- **THEN** the result carries status `not_sent`, the reason `declined` or `expired`, and no held amount
