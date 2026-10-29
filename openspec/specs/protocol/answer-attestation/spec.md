# protocol/answer-attestation Specification

## Purpose
Every answer is accepted only as a signed envelope that carries confidence and the participant's personal attestation, so that the principal can rely on who answered, when, and that a person did.

## Requirements

### Requirement: Envelope is complete or rejected
An answer SHALL be accepted only if it carries `request_id`, `participant_id`, an intent-matching `body`, `confidence` from 1 to 5, `answered_personally` equal to `true`, `signed_at`, `key_id` and `signature`; anything else SHALL be rejected with `schema_invalid` and SHALL cause no state change.

#### Scenario: Unsigned answer
- **WHEN** an answer arrives without a signature
- **THEN** it is rejected, the request stays `accepted`, and no answer is stored

#### Scenario: Attestation missing or false
- **WHEN** `answered_personally` is absent or `false`
- **THEN** the answer is rejected with `schema_invalid`

#### Scenario: Confidence out of range
- **WHEN** `confidence` is 0 or 6
- **THEN** the answer is rejected with `schema_invalid`

#### Scenario: Body does not match the intent
- **WHEN** a `judgment` request receives a body with an `estimate` field and no `verdict`
- **THEN** the answer is rejected with `schema_invalid`

### Requirement: Signature covers the canonical payload
The signature SHALL be verified by recomputing the canonical payload from the stored fields and checking it against the key identified by `key_id`; verification SHALL run before the state transition.

#### Scenario: Tampered body
- **WHEN** one character of the body changes after signing
- **THEN** verification fails and the answer is rejected

#### Scenario: Old key still verifies
- **WHEN** the signing key was rotated after an answer was signed
- **THEN** the answer still verifies through its `key_id`

#### Scenario: Revoked key
- **WHEN** an answer's `key_id` names a revoked key
- **THEN** verification fails and the answer is rejected

### Requirement: What the principal sees
`check_requests` SHALL present an answered request with the body, the confidence, the personal attestation, the signed time, the signature in display form `a2h:sig:…` followed by its last four characters, the citable form "reviewed by <initials>, <date>", and a notice when the participant is not yet identity-verified.

#### Scenario: Stored answer that no longer verifies
- **WHEN** a stored answer fails signature verification at read time (for example its key was revoked since)
- **THEN** `check_requests` does not show the envelope, reports the request by id with code `answer_unverified`, and leaves it out of lists

#### Scenario: Display of the reference answer
- **WHEN** the answer signed on 21 Oct 2026 by a participant labelled "M. V." is shown
- **THEN** the result includes the signature display form, `reviewed by M.V., 21 Oct 2026`, and the verification notice when applicable

### Requirement: Rejections log no content
A rejected answer SHALL be logged with the request id and the code only.

#### Scenario: Rejection log line
- **WHEN** an answer is rejected
- **THEN** the log line carries `request_id` and `code` and neither the body nor any identity field
