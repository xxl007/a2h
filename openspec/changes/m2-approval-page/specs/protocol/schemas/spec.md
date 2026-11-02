# Spec Delta

## MODIFIED Requirements

### Requirement: Request outcome and lane are explicit
The output of `request_human` SHALL state `status: "awaiting_approval"` with a `request_id`, an `approval_url` and an `approval_expires_at`, or `status: "not_sent"` with a `request_id` and a `reason` of `declined` or `expired`. A manifest SHALL name its `lane` (`paid`, `free` or `bounty`); a free lane bids 0 and names its `free_lane` (`own_publications` or `facts_about_self`); a paid lane bids more than 0. A principal SHALL carry an identity mode (`real_name`, `verified_organisation` or `verified_pseudonymous`) and a `verified` flag.

#### Scenario: Request not sent
- **WHEN** the principal refuses to open the approval link where the client asked through URL elicitation
- **THEN** the result validates with `status: "not_sent"`, the `request_id`, reason `declined`, and no `approval_url`

#### Scenario: Free lane with a bid
- **WHEN** a manifest names `lane: "free"` and a `bid_minor` above 0
- **THEN** schema validation fails on `bid_minor`

#### Scenario: Awaiting approval
- **WHEN** a manifest passes validation
- **THEN** the result validates with `status: "awaiting_approval"`, the `request_id`, an `approval_url` with scheme `https`, and an `approval_expires_at` in the future
