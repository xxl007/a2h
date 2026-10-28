# Spec Delta

## Purpose

A request moves through a closed set of states by legal transitions only, each caused by a known actor, and `check_requests` reports the current state and, once answered, the full signed answer.

## ADDED Requirements

### Requirement: Closed status set
A request's status SHALL be exactly one of `sent`, `accepted`, `answered`, `declined`, `expired`, `cancelled`; `answered`, `declined`, `expired` and `cancelled` SHALL be terminal.

#### Scenario: Legal transitions
- **WHEN** the transitions `sent → accepted`, `accepted → answered`, `sent → declined`, `sent → expired`, `accepted → expired` are attempted by their actors
- **THEN** each succeeds and writes one event row

#### Scenario: Illegal transition
- **WHEN** `answered → accepted` or `declined → accepted` is attempted
- **THEN** it fails with code `invalid_transition` and the status is unchanged

#### Scenario: Idempotent replay
- **WHEN** the same transition is applied twice
- **THEN** the second application changes nothing and adds no event row

### Requirement: Actors
`sent → accepted`, `sent → declined` and `accepted → answered` SHALL be caused only by the participant; `sent → expired` and `accepted → expired` only by the platform at the expiry time.

#### Scenario: Expiry by the platform
- **WHEN** a request in `sent` or `accepted` reaches its expiry time
- **THEN** its status becomes `expired` and its held amount is reported as released

### Requirement: Delivery re-validates the manifest
Before delivering a request, the platform SHALL run the participant-rules validation again against the participant's current rules; a manifest that no longer passes SHALL NOT be delivered, SHALL be counted as blocked, and the request SHALL stay `sent` until it expires.

#### Scenario: Rules changed after approval
- **WHEN** the participant's reserve rose above the bid between approval and delivery
- **THEN** nothing is delivered, a blocked-manifest row is written, and the request expires at its expiry time

### Requirement: Identity revealed on acceptance only
`check_requests` SHALL show only the handle until the request is `accepted`; from `accepted` on it SHALL show the participant's display label and verification status.

#### Scenario: Before acceptance
- **WHEN** `check_requests` is called for a request in `sent`
- **THEN** the result carries the handle and no display label

#### Scenario: After acceptance
- **WHEN** the request is `accepted`
- **THEN** the result carries the display label and whether the participant is identity-verified

### Requirement: check_requests reports state and answer
`check_requests` SHALL accept a request id or a filter (status, since) and SHALL return, per request: status, timestamps of each transition, the gross held amount, and, when `answered`, the full signed answer envelope and the gross cleared amount; an unknown id or another principal's id SHALL yield `not_found`.

#### Scenario: Answered request
- **WHEN** `check_requests` is called for an `answered` request
- **THEN** the result carries the envelope (body, confidence, personal attestation, signed time, key id, signature) and the cleared amount

#### Scenario: Filter by status
- **WHEN** `check_requests` is called with status `sent`
- **THEN** every returned request has status `sent` and belongs to the calling principal

#### Scenario: Unknown id
- **WHEN** `check_requests` is called with an id that does not exist
- **THEN** the call fails with `not_found` and reveals nothing else

### Requirement: Transition and record change together
Every status transition SHALL be written together with its event row in one atomic operation; a failure in either SHALL leave both unchanged.

#### Scenario: Atomic transition
- **WHEN** the event row cannot be written during `accepted → answered`
- **THEN** the status remains `accepted` and no answer is stored
