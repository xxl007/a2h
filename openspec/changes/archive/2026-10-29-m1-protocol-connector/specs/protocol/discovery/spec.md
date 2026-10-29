# Spec Delta

## Purpose

An agent discovers profiles, not people: `find_humans` returns ranked handles with their published terms and the inputs behind the ranking, and never a name, a contact detail or any trace on the human's side.

## ADDED Requirements

### Requirement: Discovery returns handles and published terms only
`find_humans` SHALL return a ranked list of handles, each with its expertise and evidence labels, rating summary, latency promise, gross reserve per accepted request type, free lanes and verification status, and SHALL NOT return a real name, email, phone number, URL or social handle.

#### Scenario: Result shape
- **WHEN** an agent calls `find_humans` with a topic the published profiles cover
- **THEN** each result carries a handle, topics with evidence labels, a rating summary, a latency promise, the gross reserve per accepted request type, free lanes and a verification status, and no field holds an email address, a URL, a phone number or a person's name

### Requirement: Ranking inputs are visible
Every result SHALL carry the ranking inputs as structured fields (rating, answers, disputes lost, typical latency) and as one display string of the form `4.8 · 48 answers · 0 disputes · ~6h`, so the agent's recommendation is auditable.

#### Scenario: Display string matches the fields
- **WHEN** a result has rating 4.8, 48 answers, 0 disputes and a typical latency of six hours
- **THEN** its display string is `4.8 · 48 answers · 0 disputes · ~6h`

### Requirement: Filters are honoured
`find_humans` SHALL accept `topic`, `request_type`, optional `attested`, `latency`, `max_price_minor` with `currency`, and `location`, and SHALL return only profiles that accept the request type and whose gross reserve for it does not exceed the maximum price.

#### Scenario: Maximum price excludes a profile
- **WHEN** a profile's gross reserve for `judgment` is 3125 and the call sets `max_price_minor: 3000`
- **THEN** that profile is absent from the results

#### Scenario: Attested only
- **WHEN** the call sets `attested: true`
- **THEN** every result has at least one topic with an evidence label other than self-declared

### Requirement: No match is not an error
When no profile matches, `find_humans` SHALL return an empty list with a hint that the agent may widen the filters or ask for a referral, and SHALL NOT fail the call.

#### Scenario: Empty result
- **WHEN** the topic matches no published profile
- **THEN** the result is an empty list with a hint and the call is not marked as an error

### Requirement: Discovery is silent on the human side
A `find_humans` call SHALL leave no trace visible to any participant: no delivery, no notification, no counter.

#### Scenario: Nothing recorded for participants
- **WHEN** `find_humans` returns three handles
- **THEN** no request, event, job or blocked-manifest row exists for any of the three

### Requirement: Prices shown to principals are gross
Every amount in a `find_humans` result SHALL be gross (fee included), and the result SHALL carry the fee percentage so the breakdown is available before any commitment.

#### Scenario: Gross reserve with fee metadata
- **WHEN** a profile publishes a net reserve of 2500 and the fee rate is 20%
- **THEN** the result shows a gross reserve of 3125 and a fee percentage of 20
