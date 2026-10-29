# protocol/schemas Specification

## Purpose
Every A2H shape (profiles, rules, manifests, requests, answers, attestation, money, errors, tool inputs and outputs) is defined once, is exportable as JSON Schema, and comes with pure helpers that every other part of the system uses instead of its own copy.

## Requirements

### Requirement: One definition per shape
Every shape carried by a tool, a job, a form or a test SHALL be defined once in the protocol package and consumed from there; a consumer that needs a variant SHALL derive it from the original rather than restate it.

#### Scenario: Tool schemas come from the export
- **WHEN** an MCP client lists the tools
- **THEN** every tool's input schema and output schema equal the protocol package's JSON Schema export for that tool, field for field

#### Scenario: Fixture pair per schema
- **WHEN** the passing fixture and the failing fixture of any schema are parsed
- **THEN** the passing one is accepted and the failing one is rejected with the path of the offending field

### Requirement: Money is integers in minor units with a currency
Every money field SHALL be an integer in minor units, named with the suffix `_minor`, and SHALL be paired with a three-letter ISO currency code.

#### Scenario: Fractional amount rejected
- **WHEN** a manifest carries `bid_minor: 30.5`
- **THEN** it is rejected as schema-invalid

#### Scenario: Gross from net rounds once, half up
- **WHEN** a net reserve of 2500 and a fee rate of 20% are converted to a gross reserve
- **THEN** the result is 3125 and converting 3125 back at the same rate gives 2500

### Requirement: Clearing stays between reserve and bid
The clearing function SHALL take the reserve, the bid and the share as inputs and SHALL return an amount such that reserve ≤ clearing ≤ bid for every share between 0 and 1 inclusive; no share or fee value SHALL be built into the package.

#### Scenario: Bounds hold for any share
- **WHEN** clearing is computed for reserve 2500, bid 3000 and any share from 0 to 1
- **THEN** the result is between 2500 and 3000 inclusive, equal to 2500 at share 0 and 3000 at share 1

### Requirement: Canonical answer payload
The package SHALL provide the only canonicalisation of an answer: the JSON of exactly `answered_personally`, `body`, `confidence`, `participant_id`, `request_id` and `signed_at`, with keys sorted at every level, no whitespace, UTF-8.

#### Scenario: Canonical form of the reference answer
- **WHEN** the envelope for request `A2H-7f3c` with verdict `yes`, a text note, confidence 4 and `signed_at` `2026-10-21T09:10:00+02:00` is canonicalised
- **THEN** the output is `{"answered_personally":true,"body":{"note":{"text":"..."},"verdict":"yes"},"confidence":4,"participant_id":"...","request_id":"A2H-7f3c","signed_at":"2026-10-21T09:10:00+02:00"}` with the elided values filled in, and canonicalising the same envelope with its keys in another order gives the identical string

### Requirement: Identifier formats
A request id SHALL be `A2H-` followed by four lower-case hexadecimal characters; a handle SHALL be a short lower-case slug, a hyphen and four lower-case hexadecimal characters; the formatting functions SHALL take their randomness as an argument.

#### Scenario: Request id from given randomness
- **WHEN** the request id formatter is given the bytes that spell `7f3c`
- **THEN** it returns `A2H-7f3c`

#### Scenario: Malformed id rejected
- **WHEN** `A2H-7F3C` or `A2H-7f3` is parsed as a request id
- **THEN** it is rejected

### Requirement: Request outcome and lane are explicit
The output of `request_human` SHALL state `status: "sent"` with a `request_id`, or `status: "not_sent"` with a `reason` of `declined` or `dismissed` and no id. A manifest SHALL name its `lane` (`paid`, `free` or `bounty`); a free lane bids 0 and names its `free_lane` (`own_publications` or `facts_about_self`); a paid lane bids more than 0. A principal SHALL carry an identity mode (`real_name`, `verified_organisation` or `verified_pseudonymous`) and a `verified` flag.

#### Scenario: Request not sent
- **WHEN** the principal declines or dismisses the approval
- **THEN** the result validates with `status: "not_sent"`, a `reason`, and no `request_id`

#### Scenario: Free lane with a bid
- **WHEN** a manifest names `lane: "free"` and a `bid_minor` above 0
- **THEN** schema validation fails on `bid_minor`

### Requirement: The package performs no I/O
The protocol package SHALL contain no network, file, database, clock or random access; every function SHALL be a pure function of its arguments.

#### Scenario: Works without any environment
- **WHEN** the package is loaded where network, file system and the clock are unavailable
- **THEN** every exported function still produces its result from its inputs alone
