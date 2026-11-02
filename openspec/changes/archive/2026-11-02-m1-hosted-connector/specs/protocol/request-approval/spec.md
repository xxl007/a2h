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
