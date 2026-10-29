# Spec Delta

## MODIFIED Requirements

### Requirement: A PR gets a preview stage
Opening or updating a pull request SHALL deploy a stage named after the PR number, reachable at `pr-<n>.dev.<domain>` and `mcp.dev.<domain>/pr-<n>/mcp` with its own authorization server at `pr-<n>.dev.<domain>/api/auth`, and the PR SHALL carry a comment with the web URL and the MCP endpoint URL.

#### Scenario: PR opened
- **WHEN** a pull request is opened against `main` and CI passes
- **THEN** a stage `pr-<n>` is deployed and the PR has a comment listing the web URL and the MCP endpoint, both under the domain over HTTPS

#### Scenario: PR updated
- **WHEN** new commits are pushed to an open pull request
- **THEN** the same stage is redeployed and the URLs do not change

#### Scenario: Preview tokens stay on the preview
- **WHEN** a token issued by a preview's authorization server is presented to the development stage's MCP endpoint
- **THEN** it is refused, because its issuer and audience are the preview's

### Requirement: Teardown on close
Closing or merging a pull request SHALL remove its stage, including its hostname records, and drop its schema.

#### Scenario: PR closed
- **WHEN** a pull request is closed or merged
- **THEN** its stage resources are removed, `pr-<n>.dev.<domain>` no longer resolves, and its schema no longer exists on the development cluster
