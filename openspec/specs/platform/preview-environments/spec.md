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

### Requirement: Preview is verified after deploy
After a preview stage is deployed, CI SHALL run the smoke check, the MCP contract tests and the web e2e against that stage's own URLs, and the pull request check SHALL be red when any of them fails.

#### Scenario: Preview verified
- **WHEN** stage `pr-<n>` has been deployed by the preview workflow
- **THEN** a `verify` job runs the smoke check, the contract tests and the e2e against the URLs of `pr-<n>` and the PR check is green only if all pass

#### Scenario: Verification outcome on the PR
- **WHEN** the `verify` job finishes
- **THEN** the preview comment states whether verification passed or failed and links the run

### Requirement: The development stage is verified after deploy
After `dev` is deployed from `main`, CI SHALL run the same suites against `dev` and the Deploy workflow SHALL be red when any of them fails.

#### Scenario: Merge to main verified
- **WHEN** the `dev` stage has been deployed from a commit on `main`
- **THEN** a `verify` job runs the smoke check, the contract tests and the e2e against `dev` and the workflow is green only if all pass

### Requirement: A transient deploy failure is retried once
A deploy step whose first `sst deploy` attempt fails SHALL run `sst deploy` a second time after a pause; the job SHALL fail only when the second attempt also fails.

#### Scenario: Transient failure
- **WHEN** the first `sst deploy` attempt exits non-zero
- **THEN** the step waits, runs `sst deploy` again for the same stage, and the job's result is that of the second attempt
