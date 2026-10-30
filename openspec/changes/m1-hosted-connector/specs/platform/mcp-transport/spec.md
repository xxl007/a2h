# Spec Delta

## MODIFIED Requirements

### Requirement: MCP endpoint answers over Streamable HTTP
The MCP server SHALL expose a single Streamable HTTP endpoint that accepts MCP JSON-RPC requests and returns responses per the MCP specification, without requiring a prior session; with authorization enabled on the stage, a request without a valid bearer token SHALL be answered with the 401 challenge of `platform/connector-authorization` before any MCP message is read.

#### Scenario: Initialize from a fresh client
- **WHEN** an authorized MCP client opens the connection handshake with no session header (`server/discover` on the 2026-07-28 revision; `initialize` on the 2025 revisions, which the server still accepts)
- **THEN** the server responds with its capabilities and the negotiated protocol version

#### Scenario: Tools are listed
- **WHEN** an initialized, authorized client sends `tools/list`
- **THEN** the response includes the tools `find_humans`, `request_human`, `check_requests` and `ping`, each with a description and an input schema, and the three A2H tool descriptions state that a human is a last resort, that search and existing tools come first, that the question is shown to the principal before sending, and that the principal pays what clears and never more than the hold

#### Scenario: Handshake without a token
- **WHEN** a client sends `server/discover` or `initialize` without a bearer token
- **THEN** the response is the 401 challenge and no capabilities are returned

### Requirement: Long-lived streams are not cut by infrastructure
The deployment SHALL keep an idle streaming response open for at least one hour, within the per-instance cap on held connections of `platform/hosted-endpoint`.

#### Scenario: Idle stream survives
- **WHEN** a client holds one exchange open with nothing sent in either direction for 61 minutes (for example `ping` with `holdSeconds: 3660`, which stays silent until its result)
- **THEN** the result still arrives on that connection from the client's point of view
