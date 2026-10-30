# Spec Delta

## Purpose

The MCP endpoint is an OAuth 2.1 resource server: it challenges, publishes where to get a token, verifies every token locally against the stage's authorization server, and derives the principal of every tool call from it.

## ADDED Requirements

### Requirement: Missing or invalid token is challenged
A call to the MCP endpoint without a valid bearer token SHALL be refused with HTTP 401 and a `WWW-Authenticate` header of scheme `Bearer` carrying `resource_metadata` with the stage's protected-resource metadata URL and the `scope` the endpoint needs, before any MCP message is read.

#### Scenario: No token
- **WHEN** a request without an `Authorization` header reaches the MCP endpoint
- **THEN** the response is 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="a2h"` and an empty body, and no MCP handler ran

#### Scenario: Expired token
- **WHEN** the bearer token's expiry is in the past
- **THEN** the response is 401 with `error="invalid_token"` and the same `resource_metadata`

### Requirement: Protected-resource metadata is served per stage
Each stage SHALL serve a protected-resource metadata document at the path-aware well-known URL for its MCP path, naming the stage's MCP URL as `resource`, the stage's authorization server as the only entry of `authorization_servers`, `a2h` in `scopes_supported` and `header` as the bearer method, without authentication.

#### Scenario: Metadata of a preview
- **WHEN** a client fetches `/.well-known/oauth-protected-resource/pr-<n>/mcp` on the preview host
- **THEN** it receives `resource` equal to the preview's MCP URL and `authorization_servers` equal to the preview's own issuer

### Requirement: Tokens are verified locally against the authorization server's keys
The endpoint SHALL accept a token only if its signature verifies against the keys the stage's authorization server publishes, its issuer is that server, its audience is exactly the stage's MCP URL, it has not expired and it carries the `a2h` scope; verification SHALL not call the authorization server per request, and a key the endpoint has not seen SHALL be fetched at most once a minute.

#### Scenario: Token for another resource
- **WHEN** a token issued by the same authorization server for a different audience (another stage's MCP URL) is presented
- **THEN** it is refused with 401 `invalid_token` and nothing is served

#### Scenario: Token from another issuer
- **WHEN** a token signed by a key that the stage's authorization server did not publish is presented
- **THEN** it is refused with 401 `invalid_token`

#### Scenario: Missing scope
- **WHEN** a valid token lacks the `a2h` scope
- **THEN** the response is 403 with `error="insufficient_scope"` and `scope="a2h"`

### Requirement: The principal of every tool call is the token's subject
Every tool call, approval state and created request SHALL carry as principal the account the token was issued to, never a value from the stage's configuration, and the approval state SHALL verify only for the account that received it.

#### Scenario: Request created under the signed-in principal
- **WHEN** a signed-in principal accepts an approval and the request is created
- **THEN** the request's principal is that account, and `check_requests` from another account reports `not_found` for its id

#### Scenario: Approval state used by another account
- **WHEN** an approval state minted for one account is retried with a token of another account
- **THEN** the call is refused with JSON-RPC error -32602 `invalid_request_state` and nothing is created

### Requirement: Tokens are never forwarded
The endpoint SHALL never include a received token in any outbound call, log line or stored row.

#### Scenario: Token absent from records
- **WHEN** a tool call completes
- **THEN** no log line and no database row contains the token or any substring of it longer than eight characters

### Requirement: Open paths stay open
The health path, the protected-resource metadata and the `ping` tool reached through the MCP endpoint SHALL remain reachable without a token.

#### Scenario: Health without token
- **WHEN** the load balancer probes the health path with no `Authorization` header
- **THEN** it receives 200
