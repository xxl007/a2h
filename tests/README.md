# tests

QA-owned suites for A2H. Every scenario in `openspec/specs` (and in the deltas of the change in flight) maps to a test listed below; a scenario without a test blocks its change.

| Folder | What | Runs |
|---|---|---|
| `ci/` | Tests of the CI scripts and workflows (stubbed `aws`, real Postgres 17 in Docker, parsed YAML, bootstrap JSON) and the smoke script (`preview-smoke.sh`, with its own test against a fake `curl`) | `ci.yml`, "Check CI scripts"; the smoke script itself runs in the `verify` jobs |
| `contract/` | MCP contract tests against a live MCP endpoint (`@modelcontextprotocol/client`, `node:test`) | in CI on every preview (`preview.yml`, job `verify pr-<n>`) and on `dev` after each deploy from `main` (`deploy.yml`, job `verify dev`); by hand against any stage. The idle-stream test stays opt-in, by hand |
| `e2e/` | Playwright e2e of the web app against a live web URL, Chromium only, headless | in CI on every preview and on `dev` (same `verify` jobs; the HTML report is uploaded as a run artifact on failure); by hand against any stage |
| `src/live-env.ts` | Reads the target URLs from the environment, derives the stage and the health URL | imported by `contract/` and `e2e/` |

## Running the live suites

CI runs smoke, contract and e2e after every preview deploy and after every `dev` deploy; the PR's preview comment ends with a "Verification" line (passed / FAILED, commit, run link). The commands below are for running them by hand.

The URLs come from the PR's preview comment (table "Web" and "MCP endpoint"), written by `.github/workflows/preview.yml` from `.sst/outputs.json`. For the `dev` stage, the MCP endpoint is `http://<alb-dns>/mcp`.

```sh
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
pnpm install

# MCP contract tests (one test per mcp-transport scenario; idle stream skipped)
A2H_MCP_URL=http://<alb-dns>/pr-<n>/mcp pnpm --filter @a2h/tests contract

# Idle stream, opt-in: holds one ping for A2H_IDLE_MINUTES minutes (run once per infra change, takes that long)
A2H_MCP_URL=http://<alb-dns>/pr-<n>/mcp A2H_IDLE_MINUTES=61 pnpm --filter @a2h/tests contract

# Web e2e (once per machine: install the browser)
pnpm --filter @a2h/tests exec playwright install chromium
A2H_WEB_URL=https://<id>.cloudfront.net A2H_MCP_URL=http://<alb-dns>/pr-<n>/mcp pnpm --filter @a2h/tests e2e

# Preview smoke (curl only): health, dev health, routing; prints the MCP Inspector commands
bash tests/ci/preview-smoke.sh <alb-dns> <n>
# dev smoke: /healthz only
bash tests/ci/preview-smoke.sh <alb-dns> dev
```

| Variable | Used by | Meaning |
|---|---|---|
| `A2H_MCP_URL` | contract, e2e | MCP endpoint, path `/pr-<n>/mcp` or `/mcp`. Required: the suites fail at once, saying so, when it is unset. |
| `A2H_WEB_URL` | e2e | Web URL from the preview comment. Required for e2e. |
| `A2H_STAGE` | contract, e2e | Expected stage name. Default: `pr-<n>` from the MCP path, `dev` for `/mcp`. Set `prod` for prod. |
| `A2H_IDLE_MINUTES` | contract | Unset: the idle-stream test is skipped. Integer 1..65: hold `ping` that long. |
| `A2H_SCHEME` | preview-smoke.sh | `http` (default) or `https` once a domain is set. |

Notes:

- The contract tests pin the client to protocol revision `2026-07-28` (`server/discover`, no `initialize`, no session). A server that only speaks the 2025 handshake fails them. The extra test "Compat (informational): legacy initialize handshake" is a `todo`: it reports whether 2025-era clients (MCP Inspector may be one) still connect, without failing the run.
- Every contract client records its HTTP exchanges, so the statelessness tests assert on the wire: no `Mcp-Session-Id` in any request or response, and, for the "brand-new client" test, that `tools/call` is the first request that client ever sent (it adopts another client's discover result and makes no round trip at connect).
- The idle-stream test uses undici's `fetch` with headers and body timeouts off. Node's global fetch cuts a silent response after 300 s, which would fail the test on the client, not on the infrastructure.
- Playwright 1.64 refuses to install browsers on Debian 11. There, `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu22.04-x64 pnpm --filter @a2h/tests exec playwright install chromium` downloads a build that runs. CI runners (Ubuntu) need no override.
- Page weight is the sum of Chromium's `encodedDataLength` (headers plus compressed body) over every request of the load, limit 100 KiB.
- `test-results/` and `playwright-report/` are git-ignored.

## Scenario to test map: m0-foundation

Specs: `openspec/changes/m0-foundation/specs/platform/mcp-transport/spec.md` and `.../preview-environments/spec.md`.

"Live, manual" was the M0 state: run by hand against a deployed stage. Since ci-preview-verify, every "Live, manual" row below except the idle stream runs in the `verify` jobs of `preview.yml` and `deploy.yml`. "CI" means it runs on every PR in `ci.yml`.

### platform/mcp-transport (6 scenarios)

| Scenario | Test | How it runs | Not automatable yet |
|---|---|---|---|
| Initialize from a fresh client | `contract/mcp-transport.test.ts` "Scenario: Initialize from a fresh client" (pinned `2026-07-28` connect: era modern, negotiated version, capabilities with `tools`, no session) | Live, manual | The spec says `initialize`; on `2026-07-28` the handshake is `server/discover`. The test follows the revision; the spec wording should follow too. |
| Tools are listed | `contract/mcp-transport.test.ts` "Scenario: Tools are listed" (`ping`, non-empty description, object input schema, optional integer `holdSeconds` 0..3900) | Live, manual | - |
| ping is called | `contract/mcp-transport.test.ts` "Scenario: ping is called" (no `arguments` member; text starts with `pong`, names the stage, not `isError`) | Live, manual | - |
| Requests hit different instances | `contract/mcp-transport.test.ts`, two tests: five fresh clients in a row (connect + call, no session header anywhere); a brand-new client whose first request is `tools/call` | Live, manual | A preview runs one MCP task (`McpPr<n>` 1-1), so two instances are never observed there. The tests prove the server needs no prior state; a true two-instance run needs `dev` scaled to 2 tasks, with the instance seen per response (not exposed today). |
| Load balancer probes health | `contract/mcp-transport.test.ts` "Scenario: Load balancer probes health" (200 within 1 s, no `Mcp-Session-Id`); `ci/preview-smoke.sh` (preview and dev health); `apps/mcp/test/http.test.ts` (unit, owned by Protocol-dev) | Live, manual; unit in CI | "No MCP state is created" is checked only as "no session header"; server memory is not observable from outside. |
| Idle stream survives | `contract/idle-stream.test.ts` (opt-in, `A2H_IDLE_MINUTES=61`); `infra/test/config.test.ts` checks the ALB idle timeout constant | Live, manual, once per infra change (61 min) | Too long for every PR. |

### platform/preview-environments (7 scenarios)

| Scenario | Test | How it runs | Not automatable yet |
|---|---|---|---|
| PR opened | `ci/workflows.test.mjs` (deploy needs the CI check, comment step present); `ci/preview-smoke.sh` and the two live suites against the URLs of the comment | CI (structure); live, manual (deployed stage) | The comment contents (both URLs listed) are read by eye on the PR. |
| PR updated | none automated | Live, manual: push a commit, compare the URLs in the comment before and after | Needs two deploys of one PR; candidate for the `preview-verify` job (store the URLs, compare on the next run). |
| Two PRs open | `ci/pr-schema.pg.test.sh` (two `pr_<n>` schemas and logins on Postgres 17: search path limited, a table in one is absent from the other); `ci/pr-schema.test.sh`, `ci/infra-consistency.test.sh` | CI | Not run against the real shared Aurora cluster. |
| PR closed | `ci/pr-schema.pg.test.sh` (drop), `ci/workflows.test.mjs` (teardown order: `sst remove` then drop, drop even if remove failed) | CI; live, manual: close a scratch PR, then `bash tests/ci/preview-smoke.sh <alb-dns> <n>` must fail health and routing with the ALB's 403 | Checking the schema is gone on the dev cluster needs the read-only Postgres MCP server (not connected here). |
| Typecheck fails | `ci/workflows.test.mjs` "every job that runs sst deploy needs the check job, which is ci.yml" | CI | A live red-PR run is a manual check. |
| Merge to main | `ci/workflows.test.mjs` (deploy.yml assumes the dev role, needs the check) | CI (structure) | "Deployed with that commit" is visible only in the deploy run and the stage; no test reads the deployed commit (the apps do not expose it). |
| Secrets inventory | `ci/workflows.test.mjs` "no secrets.AWS* and no long-lived AWS key inputs in any workflow"; `ci/bootstrap.test.mjs` (OIDC trust subjects) | CI | Listing the repository's actual CI secrets needs `gh secret list` with admin scope, by hand. |

The web page (owner validation step 2) has no spec scenario of its own; `e2e/hello.spec.ts` covers the PM's contract for it: `<h1>` "A2H", server-rendered (present in the HTML before scripts), stage visible, MCP URL visible, no console or page errors, under 100 KiB transferred, focus order follows the document with no positive `tabindex` and no trap.

## Scenario to test map: ci-preview-verify

Spec: `openspec/changes/ci-preview-verify/specs/platform/preview-environments/spec.md`.

| Scenario | Test | How it runs |
|---|---|---|
| Preview verified | `ci/workflows.test.mjs` "preview.yml: a verify job needs deploy and runs only when deploy reports deployed == 'true'" (needs deploy, gated on `deployed`, no `id-token`, smoke then contract then e2e on the deploy job's URLs, report uploaded on failure); `ci/preview-smoke.test.mjs` (preview mode) | CI (structure); live on every PR (`verify pr-<n>`) |
| Verification outcome on the PR | `ci/workflows.test.mjs` "preview.yml: verify appends a Verification line, with the run link, to the preview comment, whatever the outcome" | CI (structure); the line itself is read on the PR |
| Merge to main verified | `ci/workflows.test.mjs` "deploy.yml: a verify job needs deploy and runs the suites against dev"; `ci/preview-smoke.test.mjs` (dev mode) | CI (structure); live after each merge (`verify dev`) |
| Transient failure | `ci/workflows.test.mjs` "deploy.yml and preview.yml run sst deploy a second time, after a pause, when the first attempt fails" (the step is run with a fake `pnpm`: success once, fail then succeed, fail twice) | CI |

## Scenario to test map: m1-protocol-connector (package tests, group 2)

Specs: `openspec/changes/m1-protocol-connector/specs/protocol/*/spec.md`. This table lists what the `@a2h/protocol` package tests cover (Protocol-dev, task group 2). Paths are relative to `packages/protocol/test/`; all run in CI through `pnpm test` (`node --test`). "Function level" means the pure part of the scenario is tested in the package and the tool, database or worker part is still to be tested by the task named in the last column (groups 3 to 7; QA owns the live contract and adversarial tests in 7.1 and 7.2).

### protocol/schemas

| Scenario | Package test | Remaining |
|---|---|---|
| Tool schemas come from the export | `json-schema.test.ts` (export of every tool input and output, committed snapshots in `packages/protocol/json-schema/`, closed top-level objects) | Equality with the schemas `tools/list` returns: 4.5, 7.1 |
| Fixture pair per schema | `schemas.test.ts` "Scenario: Fixture pair per schema" (one pair per exported schema, offending path asserted; a guard fails if a new schema has no pair) | - |
| Fractional amount rejected | `schemas.test.ts` "Scenario: Fractional amount rejected" | - |
| Gross from net rounds once, half up | `money.test.ts` "Scenario: Gross from net rounds once, half up" (2500 at 20% → 3125 → 2500, property test over f) | - |
| Bounds hold for any share | `money.test.ts` "Scenario: Bounds hold for any share" (share 0, 1 and a property test over [0, 1]) | - |
| Canonical form of the reference answer | `canonical.test.ts` (byte-for-byte reference string, key-order independence) | - |
| Request id from given randomness | `ids.test.ts` | - |
| Malformed id rejected | `ids.test.ts` (`A2H-7F3C`, `A2H-7f3` and others) | - |
| Works without any environment | `purity.test.ts` (every exported function in a child process where clock, randomness, network and timers throw, `--permission` with read-only fs); ESLint purity rules proven on deliberate violations | - |

### protocol/request-approval

| Scenario | Package test | Remaining |
|---|---|---|
| Bid below reserve | `validate.test.ts` "Scenario: Bid below reserve" (function level: code, stage, blocked code, no reserve in the detail) | No approval shown, nothing created: 4.3, 7.1, 7.2 |
| Push-poll | `validate.test.ts` "Scenario: Push-poll"; `content-rules.test.ts` | Tool: 4.3, 7.2 |
| Third-party personal data | `validate.test.ts`; `content-rules.test.ts` | Tool: 4.3, 7.2 |
| Labour disguised as a question | `validate.test.ts`; `content-rules.test.ts` | Tool: 4.3, 7.2 |
| Quiet hours | `validate.test.ts` "Scenario: Quiet hours" (deferred, rejected and retryable, DST, unknown zone fails closed) | Result says so: 4.3, 7.1 |
| Interruption budget exceeded | `validate.test.ts` "Scenario: Interruption budget exceeded" (blocked record returned) | Row counted: 4.3, 7.2 |
| Accept after editing | - | 4.3, 7.1 |
| Decline | - | 4.3, 7.1 |
| Dismissed | - | 4.3, 7.1 |
| Altered approval state | `validate.test.ts` "Approval binding: conflict on a replayed approval with different arguments" (the `conflict` half); `manifest-hash.test.ts` | A forged or expired state is refused by the SDK before the handler (`-32602`): 4.3, 7.1; the spec split is pending (PM) |
| Edit turns the question into a push-poll | `validate.test.ts` (function level) | No request exists: 4.3, 7.1 |
| Return under a second | - | 4.3, 7.1 |
| Principal recorded | - | 4.3, 4.4, 7.1 |
| Blocked row | `validate.test.ts` "Scenario: Blocked row (record content)"; `schemas.test.ts` (a record with the question is rejected) | The database row: 3.1, 4.3 |

### protocol/request-lifecycle

| Scenario | Package test | Remaining |
|---|---|---|
| Legal transitions | `lifecycle.test.ts` (state machine, table over all 90 (state, actor, event) triples) | One event row each: 5.x, 7.1 |
| Illegal transition | `lifecycle.test.ts` | Status unchanged in the database: 5.x |
| Idempotent replay | `lifecycle.test.ts` (replay is a no-op) | No event row added: 5.4 |
| Expiry by the platform | `lifecycle.test.ts` (transition and `holdStatusAfter` → released) | Worker job: 5.4 |
| Rules changed after approval | `validate.test.ts` "Scenario: Rules changed after approval (delivery phase)" | Worker `deliver` queue: 5.2 |
| Before acceptance | `schemas.test.ts` (a `sent` result with a display label is rejected) | Tool: 4.4 |
| After acceptance | `schemas.test.ts` | Tool: 4.4 |
| Answered request | `schemas.test.ts` (an answered result needs envelope, display and cleared amount) | Tool: 4.4 |
| Filter by status | - | 4.4 |
| Unknown id | - | 4.4 |
| Atomic transition | - | 5.x |

### protocol/answer-attestation

| Scenario | Package test | Remaining |
|---|---|---|
| Unsigned answer | `schemas.test.ts` "Unsigned answer" (schema level) | Request stays `accepted`, nothing stored: 5.5 |
| Attestation missing or false | `schemas.test.ts` | Intake: 5.5 |
| Confidence out of range | `schemas.test.ts` | Intake: 5.5 |
| Body does not match the intent | `schemas.test.ts` (`answerEnvelopeSchemaFor("judgment")`) | Intake: 5.5 |
| Tampered body | `signing.test.ts` "Scenario: Tampered body" (plus every other signed field, signature flip, wrong key) | Intake: 5.5 |
| Old key still verifies | - (the package verifies with whatever key it is given) | Key lookup by `key_id`: 5.5 |
| Revoked key | - | 5.5 |
| Display of the reference answer | `display.test.ts` (signature display form, `reviewed by M.V., 21 Oct 2026`) | Notice and tool output: 4.4 |
| Rejection log line | - | 4.6, 5.5 |

### protocol/discovery

| Scenario | Package test | Remaining |
|---|---|---|
| Result shape | `schemas.test.ts` "Discovery results carry no identity" (the profile shape rejects any extra field) | Tool: 4.2 |
| Display string matches the fields | `display.test.ts` | Tool: 4.2 |
| Gross reserve with fee metadata | `money.test.ts` (2500 at 20% → 3125) | Tool: 4.2 |
| Maximum price excludes a profile, Attested only, Empty result, Nothing recorded for participants | - | 4.2 |
