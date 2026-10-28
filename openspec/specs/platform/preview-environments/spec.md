# platform/preview-environments Specification

## Purpose
Every pull request gets its own isolated preview (web URL, MCP endpoint, Postgres schema) so the product owner can validate each change on a live deployment before Gate 2.

## Requirements

### Requirement: A PR gets a preview stage
Opening or updating a pull request SHALL deploy a stage named after the PR number, and the PR SHALL carry a comment with the web URL and the MCP endpoint URL.

#### Scenario: PR opened
- **WHEN** a pull request is opened against `main` and CI passes
- **THEN** a stage `pr-<n>` is deployed and the PR has a comment listing the web URL and the MCP endpoint

#### Scenario: PR updated
- **WHEN** new commits are pushed to an open pull request
- **THEN** the same stage is redeployed and the URLs do not change

### Requirement: Preview isolation of data
Each preview stage SHALL use its own Postgres schema on the shared development cluster; one stage MUST NOT read or write another stage's schema.

#### Scenario: Two PRs open
- **WHEN** stages `pr-12` and `pr-13` both exist
- **THEN** each connects with a search path limited to its own schema and a table created in one is absent from the other

### Requirement: Teardown on close
Closing or merging a pull request SHALL remove its stage and drop its schema.

#### Scenario: PR closed
- **WHEN** a pull request is closed or merged
- **THEN** its stage resources are removed and its schema no longer exists on the development cluster

### Requirement: CI gates every PR
Every pull request SHALL run lint, typecheck and tests, and the preview deploy SHALL NOT run when any of them fails.

#### Scenario: Typecheck fails
- **WHEN** a pull request's typecheck step fails
- **THEN** no preview deploy is attempted and the PR check is red

### Requirement: Main deploys to the development stage
Merging to `main` SHALL deploy the `dev` stage.

#### Scenario: Merge to main
- **WHEN** a commit lands on `main`
- **THEN** the `dev` stage is deployed with that commit

### Requirement: No deploy outside CI
Deployments SHALL be performed only by the CI workflows through an OIDC-assumed role; no long-lived cloud credential SHALL exist in the repository or in CI secrets.

#### Scenario: Secrets inventory
- **WHEN** the repository's CI secrets are listed
- **THEN** none is an AWS access key; the deploy role is assumed via OIDC
