# Proposal: ci-preview-verify

Follow-up to m0-foundation, recorded in its tasks.md ("QA proposes a `preview-verify` job after the deploy; PM decides after Gate 2") and in the PM's Gate 2 report (one automatic retry of `sst deploy`). Approved by the product owner on 2026-10-28 ("Carry on. Write the PRs"). Tracking: issue #12, labels `change:ci-preview-verify`, `role:qa`, `milestone:M1`.

## Why

In M0 the live suites (`tests/contract`, `tests/e2e`, `tests/ci/preview-smoke.sh`) were run by hand against each preview and against `dev`, and their results were pasted into PR comments. That depends on someone remembering to run them. From M1 on, every PR deploys a preview; the preview must prove itself, and the product owner must see the proof on the PR without asking.

Two preview deploys in M0 (pr-10, pr-11) failed once each on transient AWS errors and succeeded unchanged on a rerun. A rerun by hand costs an hour of attention per incident; one automatic retry costs nothing.

## What Changes

- `preview.yml`: after `deploy pr-<n>`, a `verify` job runs the smoke check, the MCP contract tests and the web e2e against the preview's own URLs (read from the deploy job's outputs). The PR check is red when any fails. The preview comment gains a "Verification" line with the outcome and the run link. The Playwright report is uploaded as a run artifact on failure.
- `deploy.yml`: the same `verify` job runs against `dev` after each deploy from `main` (the 61-minute idle scenario stays opt-in, by hand, once per infrastructure change).
- Both deploy steps run `sst deploy` a second time, after a pause, when the first attempt fails; the job fails only when the second attempt fails. A `sst unlock` precedes the retry only if the SST state is still locked (QA checks the SST 4 docs for the exact behaviour).
- `tests/ci/workflows.test.mjs` gains structural tests for the three requirements; `tests/README.md` says the live suites now run in CI.

## Out of scope

- The idle-stream scenario in CI (takes 61 minutes; stays opt-in).
- Any change to `infra/`, to the apps, or to what the suites assert.
- Branch protection (not available on the private Free plan; unchanged).

## Capabilities

### Modified Capabilities

- `platform/preview-environments`: adds "Preview is verified after deploy", "The development stage is verified after deploy", "A transient deploy failure is retried once".

## Risks

- A verify job that is flaky makes every PR red: the suites already passed by hand on pr-10, pr-11 and dev; the e2e runs Chromium only; the first run on this change's own preview is the proof.
- CloudFront propagation right after a first deploy could fail the e2e: the smoke check runs first and the e2e has Playwright's default retries on CI.
- Retrying a deploy that failed for a real reason delays the red result by one attempt (a few minutes). Accepted.

## How the product owner validates (Gate 2)

1. Open the PR: the "Preview" comment lists the URLs and, below them, a "Verification" line that says passed, with the run link.
2. Click the run: jobs `check`, `deploy pr-<n>`, `verify pr-<n>` are green; the verify log shows the smoke checks, `# pass 6` for the contract tests and `7 passed` for the e2e.
3. After merge: the Deploy workflow on `main` shows `verify dev` green.
