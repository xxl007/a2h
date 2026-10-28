## ADDED Requirements

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
