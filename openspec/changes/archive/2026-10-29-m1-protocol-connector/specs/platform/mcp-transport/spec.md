# Spec Delta

## MODIFIED Requirements

### Requirement: MCP endpoint answers over Streamable HTTP
The MCP server SHALL expose a single Streamable HTTP endpoint that accepts MCP JSON-RPC requests and returns responses per the MCP specification, without requiring a prior session.

#### Scenario: Initialize from a fresh client
- **WHEN** an MCP client opens the connection handshake with no session header (`server/discover` on the 2026-07-28 revision; `initialize` on the 2025 revisions, which the server still accepts)
- **THEN** the server responds with its capabilities and the negotiated protocol version

#### Scenario: Tools are listed
- **WHEN** an initialized client sends `tools/list`
- **THEN** the response includes the tools `find_humans`, `request_human`, `check_requests` and `ping`, each with a description and an input schema, and the three A2H tool descriptions state that a human is a last resort, that search and existing tools come first, that the question is shown to the principal before sending, and that the principal pays what clears and never more than the hold
