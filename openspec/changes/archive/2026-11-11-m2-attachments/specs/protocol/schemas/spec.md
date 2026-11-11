# Spec Delta: protocol/schemas

## ADDED Requirements

### Requirement: Rules of engagement state the participant's attachment setting
The rules-of-engagement shape SHALL carry an attachment setting: whether the participant accepts files, and the total size in bytes they accept per request (at most 50 MB). A participant whose rules predate the setting SHALL be read as accepting files up to 50 MB until they change it. Discovery SHALL NOT publish the setting's values beyond what the profile already shows.

#### Scenario: Setting present
- **WHEN** a participant's rules accept files up to 10 MB
- **THEN** the parsed rules carry `attachments: { accepted: true, max_total_bytes: 10485760 }`

#### Scenario: Rules without the setting
- **WHEN** rules recorded before this change are read
- **THEN** they parse with files accepted up to 50 MB

### Requirement: Requests report their files without content
The request summary returned by `check_requests` SHALL carry a file summary: the number of files and the media type and size of each, in the order attached, and nothing else about them. The manifest's `attachments` for a sent request SHALL list the same files as opaque references with media type and size.

#### Scenario: Request with files
- **WHEN** a sent request has a PDF of 2 MB and a PNG of 300 KB
- **THEN** its summary carries two files with those media types and sizes in bytes, and no name or link

#### Scenario: Request without files
- **WHEN** a request has no files
- **THEN** its summary carries zero files
