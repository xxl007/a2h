# Spec Delta: protocol/request-approval

## MODIFIED Requirements

### Requirement: Manifest validation runs before anything else
`request_human` SHALL validate the manifest server side in this order: schema, principal, forbidden content, participant rules, budget, throttle; SHALL stop at the first failure; and SHALL return an error with a `code`, a `stage`, a `retryable` flag and a category-only `detail`, never the participant's rules.

#### Scenario: Bid below reserve
- **WHEN** the bid is below the participant's gross reserve for that request type
- **THEN** the call fails with code `outside_participant_rules`, no approval is shown, nothing is created, and the detail does not state the reserve

#### Scenario: Shape outside this change
- **WHEN** the manifest names an audience other than a named individual, or a threaded or recurring time shape
- **THEN** the call is refused with `schema_invalid` naming the field and the milestone that introduces it, before anything is created

#### Scenario: Attachments from the agent
- **WHEN** the manifest carries `attachments`
- **THEN** the call is refused with `schema_invalid` naming the field and saying that files are added by the principal on the approval page, before anything is created

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

## ADDED Requirements

### Requirement: Attached files follow the participant's rules
When the principal sends a request that has files, the re-validation on Send SHALL check the files against the participant's published attachment setting at that moment: whether they accept files, and the total size they accept. A request whose files the setting does not allow SHALL be refused at the participant-rules stage with `outside_participant_rules`, like any other rule, without stating the setting; nothing is held or delivered and the request stays awaiting approval, so the principal can remove the files or Don't send.

#### Scenario: Participant does not accept files
- **WHEN** the principal sends a request with one file to a participant whose rules do not accept files
- **THEN** Send is refused with `outside_participant_rules`, the page says the request is outside the participant's rules without naming the rule, and the request stays awaiting approval with its file

#### Scenario: Files over the participant's total
- **WHEN** the files' total size exceeds the total the participant's rules accept
- **THEN** Send is refused the same way

#### Scenario: Removing the files makes it sendable
- **WHEN** after such a refusal the principal removes the files and sends again
- **THEN** the request is validated without files and sent if every other rule passes

#### Scenario: Request without files is unaffected
- **WHEN** a request has no files
- **THEN** the participant's attachment setting plays no part in validation
