# platform/attachments Specification

## Purpose
Files a principal attaches to a request: what may be attached, how each file is checked before it can be sent, who can read it, and when it is deleted.

## Requirements

### Requirement: Only allowed files of bounded size
A request SHALL hold at most 5 files, each at most 25 MB, together at most 50 MB. A file SHALL be accepted only if its content, read on the server from its first bytes, is one of: PDF, PNG, JPEG, WebP, plain text (UTF-8), CSV or Markdown, and its declared type agrees with that content. Anything else SHALL be refused with a reason the principal can act on (type not allowed, too large, too many files), and the refused file SHALL be deleted.

#### Scenario: Allowed file
- **WHEN** the principal adds a 2 MB PDF to a request with no files
- **THEN** the file is accepted, its type is recorded as `application/pdf` and its size in bytes, and it moves on to the malware check

#### Scenario: Type not allowed
- **WHEN** the principal adds a ZIP archive or an executable
- **THEN** the file is refused as a type not allowed and deleted, and the request's other files are unaffected

#### Scenario: Name and content disagree
- **WHEN** a file named `report.pdf` contains an HTML document
- **THEN** it is refused as a type not allowed and deleted

#### Scenario: Too large
- **WHEN** a file is larger than 25 MB, or adding it would take the request over 50 MB
- **THEN** the upload is refused before the file is stored, with the limit stated

#### Scenario: Too many
- **WHEN** the request already holds 5 files
- **THEN** adding another is refused with the limit stated

### Requirement: Every file is scanned before it can be sent
Every accepted file SHALL be scanned for malware before it counts as ready. A file SHALL be in exactly one state: uploading, checking, ready, or refused. A file flagged by the scan SHALL be refused and deleted, and the principal SHALL be told that the file was refused by the security check, without the detection name. A file whose check does not finish within 10 minutes SHALL be refused as not checked, so that it never reaches a participant unchecked.

#### Scenario: Clean file
- **WHEN** the scan of an accepted file finds nothing
- **THEN** the file becomes ready

#### Scenario: Malicious file
- **WHEN** the principal uploads the EICAR test file named `notes.txt`
- **THEN** the file is refused by the security check and deleted, and the page says so without naming the detection

#### Scenario: Scan does not finish
- **WHEN** a file's scan result has not arrived 10 minutes after upload
- **THEN** the file is refused as not checked and deleted

### Requirement: Only the request's principal can read files before M3
Until participants can open requests (M3), a file SHALL be readable only by the principal of its request, signed in, through a link that works for at most 5 minutes, is bound to that file, and makes the browser download or display the file without running it. No file SHALL be reachable by a stable or guessable address. Agents, other principals and participants SHALL NOT be able to read file content in this change.

#### Scenario: Principal opens their file
- **WHEN** the principal opens a ready file from the approval page
- **THEN** the browser receives the file through a link that stops working after 5 minutes

#### Scenario: Another account
- **WHEN** another signed-in principal asks for that file's link
- **THEN** nothing is returned that reveals the file exists

#### Scenario: Old link
- **WHEN** a file link is used after it has expired
- **THEN** the storage refuses it

### Requirement: Files never leave through logs, emails or agents
File names and content SHALL NOT appear in logs, metrics, emails or MCP results. MCP results and emails MAY state the number of files and their types; logs MAY state counts, sizes, types and opaque file ids.

#### Scenario: Agent checks a request with files
- **WHEN** the agent calls `check_requests` for a sent request with a PDF and a PNG
- **THEN** the result states two files, `application/pdf` and `image/png`, and no file name

#### Scenario: Logs of an upload
- **WHEN** a file is uploaded, checked and attached
- **THEN** no log line contains its name or any of its content

### Requirement: Files are deleted with the request they belong to
Files of a request that is not sent (Don't send, link expired, or never sent) SHALL be deleted within one hour of that outcome. Files the principal removes before Send SHALL be deleted at once. Files of a sent request SHALL be kept unchanged for 180 days, then deleted, and SHALL be deleted earlier when the request is erased.

#### Scenario: Don't send
- **WHEN** the principal chooses Don't send on a request with two files
- **THEN** both files are deleted within an hour and their links stop working

#### Scenario: Link expires
- **WHEN** the approval link of a request with a file expires unused
- **THEN** the file is deleted within an hour of the request becoming not sent

#### Scenario: Sent files are fixed
- **WHEN** a request with files has been sent
- **THEN** its files can no longer be added, removed or replaced by anyone
