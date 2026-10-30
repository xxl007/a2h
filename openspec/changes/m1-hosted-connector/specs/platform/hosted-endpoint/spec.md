# Spec Delta

## Purpose

The public surface of a stage: its hostnames under the product domain, TLS with HTTP redirected, rate limits at the edge and per principal, and the cap on connections held open on purpose.

## ADDED Requirements

### Requirement: Stage hostnames under the product domain
With a domain configured, each stage SHALL be reachable at derived hostnames: production web at the apex and MCP at `mcp.<domain>`; development web at `dev.<domain>` and MCP at `mcp.dev.<domain>/mcp`; preview `pr-<n>` web at `pr-<n>.dev.<domain>` and MCP at `mcp.dev.<domain>/pr-<n>/mcp`; DNS records and certificates SHALL be created by the deployment, never by hand.

#### Scenario: Development hostnames resolve
- **WHEN** the development stage is deployed with the domain configured
- **THEN** `dev.<domain>` and `mcp.dev.<domain>` resolve, present certificates valid for those names issued by a public authority, and serve the web app and the MCP endpoint respectively

### Requirement: HTTPS only
Every public hostname SHALL serve HTTPS with a valid certificate, and a plain HTTP request SHALL be answered with a permanent redirect to the same URL over HTTPS and nothing else.

#### Scenario: HTTP redirected
- **WHEN** a client requests `http://mcp.dev.<domain>/mcp`
- **THEN** it receives 301 with `Location: https://mcp.dev.<domain>/mcp` and no body is served over HTTP

### Requirement: Edge rate limit per source address
The MCP and authorization paths SHALL be rate-limited at the edge per source address with a limit configured per stage; a source over the limit SHALL receive 429 for the rest of the window, and the health path SHALL never be limited.

#### Scenario: Flood from one address
- **WHEN** one source address exceeds the stage's edge limit within the window
- **THEN** its further requests to the MCP and authorization paths get 429 until the window ends, while other addresses are unaffected

### Requirement: Per-principal tool-call limit
Tool calls SHALL be limited per principal per minute and per day with limits configured per stage; a call over the limit SHALL fail with a result that names when to retry, SHALL count as nothing (no request, no hold, no blocked row), and the limit SHALL hold across instances of the stage.

#### Scenario: Minute limit reached
- **WHEN** a principal exceeds the per-minute limit
- **THEN** the next tool call returns an error result with code `rate_limited` and the number of seconds to wait, and no request or hold was created by it

#### Scenario: Limit shared across instances
- **WHEN** a principal's calls are spread over two instances of the stage
- **THEN** the limit applies to their sum

### Requirement: Held connections are capped
The number of `ping` calls held open at the same time SHALL be capped per instance with a value configured per stage; a call beyond the cap SHALL be refused immediately with `rate_limited` rather than queued.

#### Scenario: Cap reached
- **WHEN** the cap is already reached and another held `ping` arrives on the same instance
- **THEN** it returns `rate_limited` at once, and the held calls already running are unaffected
