# platform/approval-page Specification

## Purpose
The hosted page where a principal reviews one request exactly as the participant will receive it, edits the question, and sends it or refuses it. It is the only place a request can be approved.

## Requirements

### Requirement: Only the request's principal sees the request
The approval page SHALL require a signed-in session whose principal is the request's principal and whose address is on the stage's allow-list; anyone else SHALL see no detail of the request and no action.

#### Scenario: Signed out
- **WHEN** someone opens an approval link without a session
- **THEN** they are sent to sign in and, after signing in as the request's principal, return to the same approval page

#### Scenario: Wrong principal
- **WHEN** a different signed-in principal opens the link
- **THEN** the page says the link belongs to another account and shows no question, participant, amount or action

### Requirement: The page shows what the participant will receive
The page SHALL show the question as the participant will read it, and the participant's display label and whether it is simulated, the request type, the answer format, every poll option and the scale verbatim, the gross hold with its fee breakdown, the expiry in the viewer's time zone with its offset, the data terms and when delivery happens.

#### Scenario: Poll request
- **WHEN** the request is a poll with options and a scale
- **THEN** every option label and the scale appear verbatim, in the order the participant will see them

#### Scenario: Simulated participant
- **WHEN** the participant is simulated
- **THEN** the page says so next to the participant's label, and that no person will be asked

#### Scenario: Time zone
- **WHEN** the page is opened in a browser set to a time zone other than UTC
- **THEN** the expiry is shown in that time zone with its offset

### Requirement: The question is editable in place
The question SHALL be editable on the page with its character count and limit; once edited, a "Restore agent draft" action SHALL bring back the agent's text exactly.

#### Scenario: Restore agent draft
- **WHEN** the principal edits the question and chooses "Restore agent draft"
- **THEN** the field holds the agent's text byte for byte and the action disappears

#### Scenario: Over the limit
- **WHEN** the edited question exceeds the limit
- **THEN** the count says by how much and Send is unavailable until it fits

### Requirement: Two actions, money on the send action
The page SHALL offer exactly two decisions: "Send · hold €N" (or "Send" on a free lane), and "Don't send"; neither SHALL be pre-selected or triggered by pressing Enter in the question.

#### Scenario: Labels
- **WHEN** the page shows a paid request with a gross bid of €35.00
- **THEN** the send action reads "Send · hold €35.00" and the other reads "Don't send"

#### Scenario: Enter in the question
- **WHEN** the principal presses Enter inside the question
- **THEN** a line break is inserted and no decision is submitted

### Requirement: Every state of the page is stated
The page SHALL have a distinct, worded state for: awaiting decision, sending, sent, not sent, link expired, already decided, validation failed after an edit, wrong principal, and offline.

#### Scenario: Already decided
- **WHEN** the link of a request that was sent is opened again
- **THEN** the page says it was sent, when, and that the agent can check it, and offers no action

#### Scenario: Validation failed after an edit
- **WHEN** Send is refused because the edited question breaks a content rule
- **THEN** the page keeps the edited text, names the category of the problem, and leaves both actions available

### Requirement: The page is accessible
The page SHALL meet WCAG 2.2 AA, be complete with a keyboard, give every target at least 44 by 44 px, respect reduced motion, and work on a 320 px wide screen without horizontal scrolling.

#### Scenario: Keyboard only
- **WHEN** the page is used with a keyboard alone
- **THEN** the question, "Restore agent draft", and both decisions are reachable in a logical order with a visible focus indicator

#### Scenario: Narrow screen
- **WHEN** the page is shown 320 px wide
- **THEN** nothing scrolls horizontally and both decisions are visible without zooming

### Requirement: The principal can attach files before Send
While a request awaits approval, the page SHALL let its principal add files (by choosing them or dropping them) and remove them, and SHALL show each file's name, type, size and state (uploading with progress, checking, ready, refused with its reason). Send SHALL be unavailable, with the reason stated next to it, while any file is uploading or checking or any refused file is still listed. The facts the page shows SHALL include the files as part of what the participant will receive. Adding and removing files SHALL work with the keyboard alone and on a phone (including choosing a photo), and every state change SHALL be announced to assistive technology.

#### Scenario: Add and send
- **WHEN** the principal adds a PDF, waits until it is ready and chooses Send
- **THEN** the request is sent with that file, and the sent page lists the file as part of the question as sent

#### Scenario: Send waits for checking
- **WHEN** a file is still being checked
- **THEN** Send is unavailable and the page says files are being checked; it becomes available when every file is ready

#### Scenario: Refused file blocks Send until removed
- **WHEN** a file is refused
- **THEN** it stays listed with its reason, Send is unavailable, and removing it makes Send available again

#### Scenario: Remove a file
- **WHEN** the principal removes a ready file
- **THEN** it disappears from the list and is not part of the request

#### Scenario: Files on a sent request
- **WHEN** the principal opens the link of a sent request with files
- **THEN** the files are listed and can be opened, but cannot be added or removed

#### Scenario: Keyboard and phone
- **WHEN** the principal adds and removes a file with the keyboard only, or from a phone at 390 px
- **THEN** every control is reachable, targets are at least 44 px, and each state change is announced
