# Spec Delta: platform/approval-page

## ADDED Requirements

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
