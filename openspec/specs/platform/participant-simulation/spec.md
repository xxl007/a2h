# platform/participant-simulation Specification

## Purpose
On development and preview stages a set of synthetic participants with scripted behaviour accepts, declines, answers or ignores requests, so the principal-side flow can be validated end to end without a human and without any outbound message.

## Requirements

### Requirement: Simulated participants exist off production only
Development and preview stages SHALL hold a seeded set of simulated participants with published profiles and rules; the production stage SHALL hold none and SHALL have the simulator disabled.

#### Scenario: Only simulated participants are delivered
- **WHEN** a request addressed to a participant that is not simulated becomes due in this change
- **THEN** it is not delivered and stays `sent` until it expires (real delivery arrives with M3)

#### Scenario: Seed on a preview
- **WHEN** a preview stage is deployed
- **THEN** `find_humans` returns the simulated set for its topics

#### Scenario: Nothing on production
- **WHEN** the production stage is deployed
- **THEN** no simulated participant exists and the simulator job is not registered

### Requirement: Simulation is unmistakable
Every simulated participant's handle SHALL start with `sim-`, its display label SHALL end with "(simulated)", and every answer it produces SHALL carry `simulated: true` in `check_requests`.

#### Scenario: Marked in discovery and in answers
- **WHEN** a simulated participant is found and later answers
- **THEN** its handle starts with `sim-`, its label ends with "(simulated)", and the answer carries `simulated: true`

### Requirement: Scripted personas
The set SHALL include at least these personas: accepts and answers within its delay; declines with a reason; accepts, then answers slowly; answers "can't tell"; never responds so the request expires. Each persona's delay SHALL be under two minutes on previews.

#### Scenario: Prompt answer
- **WHEN** a request is sent to the prompt persona
- **THEN** within its delay the request is `accepted` and then `answered` with a body matching the request's intent

#### Scenario: Decline
- **WHEN** a request is sent to the declining persona
- **THEN** the request becomes `declined` with a decline reason and nothing is charged

#### Scenario: Can't tell
- **WHEN** a request is sent to the "can't tell" persona
- **THEN** the answer body carries the `cant_tell` verdict and the answer is otherwise complete

#### Scenario: Silent until expiry
- **WHEN** a request with a short expiry is sent to the silent persona
- **THEN** the request becomes `expired` at its expiry time

### Requirement: Simulated answers are genuine envelopes
A simulated answer SHALL be a complete envelope signed with the stage's development signing key and SHALL pass the same verification as a real answer.

#### Scenario: Verifies like a real answer
- **WHEN** a simulated answer is stored
- **THEN** recomputing its canonical payload and verifying the signature with its `key_id` succeeds

### Requirement: Seeding is idempotent
Deploying a stage twice SHALL leave exactly one copy of the simulated set.

#### Scenario: Redeploy
- **WHEN** the same stage is deployed again
- **THEN** `find_humans` returns the same handles once each

### Requirement: Simulation sends nothing outward
The simulator SHALL send no email and make no network call outside the platform.

#### Scenario: No outbound traffic
- **WHEN** the simulator processes a request
- **THEN** no email is sent and no outbound request leaves the worker
