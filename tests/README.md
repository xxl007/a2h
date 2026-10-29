# tests

QA-owned suites for A2H. Every scenario in `openspec/specs` (and in the deltas of the change in flight) maps to a test listed below; a scenario without a test blocks its change.

| Folder | What | Runs |
|---|---|---|
| `ci/` | Tests of the CI scripts and workflows (stubbed `aws`, real Postgres 17 in Docker, parsed YAML, bootstrap JSON) and the smoke script (`preview-smoke.sh`, with its own test against a fake `curl`) | `ci.yml`: job `check`, step "Check CI scripts" (stubbed `aws`, YAML, JSON); job `scripts-pg` (the `.pg` and `db-migrate` tests on Postgres 17 in Docker, which fail instead of skipping there); the smoke script itself runs in the `verify` jobs |
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
| Blocked row | `validate.test.ts` "Scenario: Blocked row (record content)"; `schemas.test.ts` (a record with the question is rejected); database side in the group 3 table below | Row written by the tool: 4.3 |

### protocol/request-lifecycle

| Scenario | Package test | Remaining |
|---|---|---|
| Legal transitions | `lifecycle.test.ts` (state machine, table over all 90 (state, actor, event) triples); database side in the group 3 table below | One event row each, written by the code: 5.x, 7.1 |
| Illegal transition | `lifecycle.test.ts`; database side in the group 3 table below | Status unchanged in the database: 5.x |
| Idempotent replay | `lifecycle.test.ts` (replay is a no-op); database side in the group 3 table below | No event row added by the job: 5.4 |
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
| Old key still verifies | - (the package verifies with whatever key it is given); the table keeps rotated keys, group 3 table below | Key lookup by `key_id`: 5.5 |
| Revoked key | database: a revoked key never comes back, group 3 table below | Verification refuses it: 5.5 |
| Display of the reference answer | `display.test.ts` (signature display form, `reviewed by M.V., 21 Oct 2026`) | Notice and tool output: 4.4 |
| Rejection log line | - | 4.6, 5.5 |

### protocol/discovery

| Scenario | Package test | Remaining |
|---|---|---|
| Result shape | `schemas.test.ts` "Discovery results carry no identity" (the profile shape rejects any extra field) | Tool: 4.2 |
| Display string matches the fields | `display.test.ts` | Tool: 4.2 |
| Gross reserve with fee metadata | `money.test.ts` (2500 at 20% → 3125) | Tool: 4.2 |
| Maximum price excludes a profile, Attested only, Empty result, Nothing recorded for participants | - | 4.2 |

## Scenario to test map: m1-protocol-connector (database and CI scripts, group 3)

Tasks 3.1 to 3.4. `packages/db/test/` runs with `pnpm --filter @a2h/db test` (part of `pnpm test`); its database tests start a PostgreSQL 17 container and are skipped without Docker unless `A2H_DB_PG_REQUIRED=1`. `ci/db-migrate.test.sh` and `ci/pr-schema*.test.sh` run the scripts against the stubbed `aws` (`ci/lib/bin/aws`, which now also plays Data API transactions) and, for the `.pg` parts, Postgres 17 in Docker; `db-migrate.test.sh` skips its database part without Docker unless `DB_MIGRATE_PG_REQUIRED=1`. It takes about four minutes. Since task 6.2 it runs in `ci.yml` (job `scripts-pg`) with the flag set; see the next section.

"Database side" means the constraint holds in Postgres whatever the application code does; the scenario's behaviour through a tool or job is still tested by the task named in the last column.

| Scenario | Test | Remaining |
|---|---|---|
| request-approval: Blocked row | `packages/db/test/schema.test.ts` "Scenario: Blocked row" (columns are ids, stage, code, time; no unbounded type; code list from `@a2h/protocol`); `constraints.test.ts` "Scenario: Blocked row" (the question in the code column, an unknown code, long text in an id column are refused; no question column; append-only) | Row written on a rules block: 4.3, 5.2 |
| request-lifecycle: Legal transitions, Illegal transition (closed set) | `constraints.test.ts` "request lifecycle" (event rows accept exactly the protocol's legal (from, to, actor), derived from `transition()`; unknown status refused) | Status and event written together: 5.x |
| request-lifecycle: Idempotent replay | `constraints.test.ts` (a second event with the same target state is refused, unique `(request_id, to_status)`) | Job treats the replay as a no-op: 5.4 |
| answer-attestation: Envelope is complete or rejected | `constraints.test.ts` "answers" (attestation false or missing, confidence 0 or 6, no or malformed signature, unknown key refused; `signed_at` kept verbatim; append-only, one per request) | Intake rejects before storing: 5.5 |
| answer-attestation: Old key still verifies, Revoked key | `constraints.test.ts` "signing keys" (one active key per owner; rotation keeps the public key; rotated or revoked never returns to active; keys never deleted) | Verification by `key_id`: 5.5 |
| participant-simulation: Marked in discovery and in answers (data side) | `constraints.test.ts` "Simulation is unmistakable" (`sim-` handle ⇔ `simulated` ⇔ label ending "(simulated)" ⇔ persona); `seed.test.ts` "the simulated set" | Tool output: 4.2, 4.4 |
| participant-simulation: Redeploy | `seed.test.ts` "Scenario: Redeploy" (seed applied twice: twelve participants, once each); `ci/db-migrate.test.sh` section 3 (second run of the script: no migration re-applied, still twelve) | `find_humans` returns each handle once: 4.2, 7.1 |
| participant-simulation: Nothing on production (seed side) | `seed.test.ts` "never on prod" and "never without a stage" (the SQL refuses); `ci/db-migrate.test.sh` section 8 (prod: migrations only, no participant, no persona, no seed statement) | Simulator not registered on prod: 5.6 |
| participant-simulation: Scripted personas (delays) | `constraints.test.ts` (persona delay under two minutes, decline reason only on the decline persona); `seed.test.ts` (five personas, each used) | Behaviour: 5.3 |
| design D2: migrations per stage | `ci/db-migrate.test.sh`: first run (one transaction per file, tracking with SHA-256), re-run (no-op), preview (`SET LOCAL ROLE pr_<n>`, everything owned by `pr_<n>`, nothing in `public`), ownership fallback when the role is not kept, failing file (rolled back, no tracking row, nothing after it), changed file (refused), prod (given ARNs, no seed), retry while resuming | Workflow step: 6.2 |
| design D3: jobs schemas | `ci/pr-schema.test.sh` and `ci/pr-schema.pg.test.sh` (`pr_<n>_jobs` created owned by `pr_<n>`, isolated from other previews, kept on re-create, dropped with the preview; no secret but `a2h/pr-<n>/db` touched); `ci/db-migrate.test.sh` (`pgboss` on dev and prod) | Worker uses it: 5.1 |
| preview-environments: Two PRs open, PR closed (both schemas) | `ci/pr-schema.pg.test.sh` | - |

## Scenario to test map: m1-protocol-connector (workflows, task 6.2)

Design D2 and Migration Plan step 2: `.github/scripts/db-migrate.sh <stage>` runs in `deploy.yml` (`dev`) and `preview.yml` (`pr-<n>`) after the AWS credentials and before `sst deploy`; on previews after `pr-schema.sh create`. Every test below is in `ci/workflows.test.mjs` (parsed YAML; the migration step itself is run with bash against a fake `db-migrate.sh`) and runs in CI on every PR. `actionlint` runs in `ci.yml` before them. There is no prod job in `deploy.yml` today, so no prod migration step; `db-migrate.sh prod` refuses without `A2H_DB_CLUSTER_ARN` and `A2H_DB_SECRET_ARN` (checked here too).

### Behaviour: Preview is migrated before deploy

| Behaviour | Test | How it runs | Not automatable yet |
|---|---|---|---|
| Migrated before deploy, in every deploying job | "db-migrate.sh runs in exactly the jobs that run sst deploy (deploy.yml, preview.yml), nowhere else" | CI | - |
| Order: credentials, `pr-schema.sh create` (previews), migration, `sst deploy` | "the migration step comes after the AWS credentials and before sst deploy; on previews after pr-schema.sh create" | CI | - |
| The job's own stage, and the same stage as the deploy | "the migration step migrates the job's own stage: dev in deploy.yml, pr-<n> in preview.yml" | CI | - |
| Cluster from the shared SSM parameters, like `pr-schema.sh`; no ARN override, no secret, no tracing in the step | "the migration step reads the cluster from the shared SSM parameters, as pr-schema.sh does: no ARN, no secret, no tracing" | CI | That the log holds no secret is read on the run log of the PR's preview (the script prints stage, schema, cluster ARN, file names, seed line) |
| Fail closed: a failed migration fails the job, nothing deploys after it, the failure comment replaces the URLs | "a failed migration fails the job and nothing deploys after it (fail closed)"; "the migration step passes the stage as the one argument and fails with the script" (exit 1 and 64 fail the step) | CI | A live failed migration on a preview is not provoked |
| CLI contract the workflows rely on (`dev`, `pr-<n>`, usage errors, prod refused without ARNs) | "the CLI contract the workflows rely on: db-migrate.sh accepts dev and pr-<n>, refuses prod without ARNs" | CI | - |
| Seed on a preview (participant-simulation, deploy side): the seed runs on `pr-<n>` | the step above plus `ci/db-migrate.test.sh` (seed on previews and dev) | CI; live on every preview deploy (run log: `db-migrate: seed: applied the simulated set to pr_<n>`) | `find_humans` returning the set: 4.2, 7.1 |
| Teardown unchanged: no migration, `pr-schema.sh drop` the last step touching AWS | "the teardown is unchanged: no migration, and pr-schema.sh drop is the last step that touches AWS"; the existing teardown-order tests | CI | - |

### Docker-backed tests cannot skip silently

| Behaviour | Test | How it runs |
|---|---|---|
| Every `tests/ci/*.test.sh` runs in `ci.yml` | "ci.yml runs every tests/ci/*.test.sh script (none left out)" | CI |
| `PR_SCHEMA_PG_REQUIRED=1`, `DB_MIGRATE_PG_REQUIRED=1` on the steps that run their scripts | "every *_PG_REQUIRED flag a CI script test defines is set to 1 on the step that runs it" | CI |
| `A2H_DB_PG_REQUIRED=1` on `pnpm test`, and declared in `turbo.json` (turbo's strict env mode dropped it before: checked by running `packages/db` tests through turbo with a failing `docker`, 0 failures without the declaration, 2 with it) | "packages/db's database tests cannot skip in CI: A2H_DB_PG_REQUIRED=1 on pnpm test, and turbo passes it through" | CI |
| The Postgres job is unconditional and gates the deploys (preview and deploy call the whole of `ci.yml`) | "every ci.yml job runs unconditionally and its test steps cannot be ignored, so the check gates on all of them" | CI |

## Scenario to test map: m1-protocol-connector (apps/mcp, group 4)

Tasks 4.1 to 4.6. `apps/mcp/test/` runs with `pnpm --filter @a2h/mcp test` (part of `pnpm test`). The tool tests run the real HTTP app with the real tools in-process, drive it with the official client (`@modelcontextprotocol/client` 2.4.0, pinned to 2026-07-28 unless the test needs a 2025-era client), and read and write a PostgreSQL 17 container with the real migrations and the real simulated seed (`apps/mcp/test/lib/db.ts`, built on `packages/db/test/lib/postgres.ts`); they are skipped without Docker unless `A2H_DB_PG_REQUIRED=1`. The clock is pinned (Tuesday 27 Oct 2026, 09:00 UTC) except where a scenario needs another time. Where the worker's part of a scenario is needed (accept, answer, expire), the test writes the rows the worker writes; the worker's own behaviour is group 5.

### protocol/discovery (`find-humans.test.ts`)

| Scenario | Test |
|---|---|
| Result shape | "Scenario: Result shape" (strict profile shape; no email, URL, phone number or any part of a seeded name in the whole result) |
| Display string matches the fields | "Scenario: Display string matches the fields" (`sim-mv-7f3c`: `4.8 · 48 answers · 0 disputes · ~6h`) |
| Maximum price excludes a profile | "Scenario: Maximum price excludes a profile" (gross 3125: present at 3125, absent at 3000) |
| Attested only | "Scenario: Attested only" (the self-declared profile matches without the filter, not with it) |
| Empty result | "Scenario: Empty result" (empty list, hint, not an error) |
| Nothing recorded for participants | "Scenario: Nothing recorded for participants" (no request, event, blocked-manifest or answer row; no jobs schema touched) |
| Gross reserve with fee metadata | "Scenario: Gross reserve with fee metadata" (3125 and `fee_percent` 20, also in the text) |
| Filters are honoured (request type, latency) | "Filters: only profiles that accept the request type; latency promise within the limit" |

### protocol/request-approval (`request-human.test.ts`)

| Scenario | Test |
|---|---|
| Bid below reserve | "Scenario: Bid below reserve" (no `input_required`, nothing created, no reserve figure in the result, one blocked row) |
| Push-poll | "Scenario: Push-poll" (`forbidden_content`, stage `content`, question not echoed) |
| Third-party personal data | "Scenario: Third-party personal data" |
| Labour disguised as a question | "Scenario: Labour disguised as a question" |
| Quiet hours | "Scenario: Quiet hours" (deferred to 07:00 London when the expiry allows; `outside_participant_rules`, `retryable: true` when not) |
| Interruption budget exceeded | "Scenario: Interruption budget exceeded" (third request of the day refused, blocked row `interruption_budget`) |
| Approval shows the exact wording (form and message) | "Approval: one pre-filled text field holding the question; message with gross bid, format, expiry, data terms and Send · hold" |
| Accept after editing | "Scenario: Accept after editing" (stored question byte-identical to the edit, UTF-8 compared as hex) |
| Decline | "Scenario: Decline" (`not_sent`, `declined`, nothing created, `check_requests` lists nothing) |
| Dismissed | "Scenario: Dismissed" (`not_sent`, `dismissed`) |
| Forged or expired approval state | "Scenario: Forged or expired approval state" (tampered, minted with another key, malformed, and the genuine state after fifteen minutes: JSON-RPC `-32602`, reason `invalid_request_state`; nothing created) |
| Approval state replayed with changed arguments | "Scenario: Approval state replayed with changed arguments" (bid, handle, expiry changed; also no state at all: `conflict`) |
| Client on an older revision | "Scenario: Client on an older revision" (2025-era client: error text names 2026-07-28 and `MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude`; never asked; nothing created) |
| Edit turns the question into a push-poll | "Scenario: Edit turns the question into a push-poll" |
| Return under a second | "Scenario: Return under a second" (retry leg under 1 s; `A2H-xxxx`, ETA = delivery + latency promise, `sent`, held = gross bid) |
| Principal recorded | "Scenario: Principal recorded" (principal id on the row, first event `null → sent` by the principal; another principal gets `not_found`) |
| Blocked row | "Scenario: Blocked row" (columns are id, request id, participant id, principal id, stage, code, time; no question) |
| Design D1: stateless across instances | "The round trip works across two instances" |
| Design D7: authorisation refused for the development principal | "The development principal cannot send an authorisation request" |

### protocol/request-lifecycle, display (`check-requests.test.ts`)

| Scenario | Test |
|---|---|
| Before acceptance | "Scenario: Before acceptance" (handle, no label, no verification status, no name anywhere) |
| After acceptance | "Scenario: After acceptance" (label and identity verification) |
| Answered request | "Scenario: Answered request" (envelope returned exactly as signed, cleared amount, `simulated: true`) |
| Filter by status | "Scenario: Filter by status" (only the caller's `sent` requests; limit; since) |
| Unknown id | "Scenario: Unknown id" (`not_found`, nothing else revealed) |
| Expiry by the platform (what check_requests reports) | "Scenario: Expiry by the platform (display)" (hold reported `released`) |

### protocol/answer-attestation, display (`check-requests.test.ts`)

| Scenario | Test |
|---|---|
| Display of the reference answer | "Scenario: Display of the reference answer" (`a2h:sig:…` + last four, `reviewed by M.V., 21 Oct 2026`, verification notice only for a not-yet-verified participant) |
| Old key still verifies (display) | "Scenario: Old key still verifies" (answer signed with a rotated key is shown) |
| Revoked key, Tampered body (display) | "Revoked key or tampered body: the answer is not presented as verified" (refused by id, left out of lists) |
| Rejection log line | Intake is group 5 (5.5); the mcp side's log lines are covered below |

### platform/mcp-transport (modified) and protocol/schemas

| Scenario | Test |
|---|---|
| Tools are listed | `apps/mcp/test/mcp-transport.test.ts` "[legacy]/[modern] Tools are listed" (four tools, policy text in the three A2H descriptions); live: `tests/contract/mcp-transport.test.ts` "Scenario: Tools are listed" |
| Tool schemas come from the export | `apps/mcp/test/mcp-transport.test.ts` "Scenario: Tool schemas come from the export" (input and output schemas deep-equal `toolJsonSchemas()`) |
| Marked in discovery and in answers (tool side) | `find-humans.test.ts` "Marked in discovery"; `check-requests.test.ts` "Scenario: Answered request" |

### design D9 logging and task 4.1 configuration

| What | Test |
|---|---|
| No question or body text in logs, ids and codes present | `logging.test.ts` (blocked and rejected paths; approval paths incl. forged state, conflict, decline, accept; find_humans and check_requests with an answered request) |
| Deployment adapter | `env.test.ts` (connection string, TLS against `DB_CA_BUNDLE`, approval key length, principal and policy, missing or invalid variables named without values) |
| Refuses to start without a readable `DB_CA_BUNDLE` when set | `env.test.ts` "startup: the service refuses to start…" (spawns `src/index.ts`, exit 1, no secret in the output) |

## Scenario to test map: m1-protocol-connector (apps/worker, group 5)

Tasks 5.1 to 5.6. `apps/worker/test/` runs with `pnpm --filter @a2h/worker test` (part of `pnpm test`). The database tests start PostgreSQL 17 in Docker through `packages/db/test/lib/postgres.ts`, set it up as a preview (`test/lib/stage-db.ts`: login `pr_12` owns `pr_12` and `pr_12_jobs`, no CREATE on the database, migrations applied as the login, the simulated set seeded with `a2h.stage = pr-12`), and are skipped without Docker unless `A2H_DB_PG_REQUIRED=1`. Handlers are called directly with an injected clock; `worker-run.test.ts` runs the whole worker through pg-boss with persona delays shortened to 1 s.

| Scenario | Test |
|---|---|
| request-lifecycle: Rules changed after approval | `apps/worker/test/deliver.test.ts` "Scenario: Rules changed after approval" (reserve raised above the bid: no simulate job, `blocked` delivery row, one `blocked_manifests` row with ids, stage `rules` and `bid_below_reserve`, request stays `sent`, a retry does not count it twice, then `expired` at its expiry time; no question text logged) |
| request-lifecycle: Expiry by the platform | `expire.test.ts` "Scenario: Expiry by the platform" (`sent` and `accepted` → `expired` by `platform` at the expiry time, not before; hold reported `released`) |
| request-lifecycle: Idempotent replay | `expire.test.ts` "Scenario: Idempotent replay" (expiry twice, also concurrently: one event); `answer-intake.test.ts` "Scenario: Idempotent replay" (same answer twice: one answer, no second event) |
| request-lifecycle: Atomic transition | `answer-intake.test.ts` "Scenario: Atomic transition" (the `answered` event row cannot be written: status stays `accepted`, no answer stored) |
| request-lifecycle: Legal transitions (participant and platform moves) | `simulate.test.ts` "Scenario: Prompt answer" (`sent → accepted → answered`, one event each), "Scenario: Decline", `expire.test.ts` |
| answer-attestation: Unsigned answer | `answer-intake.test.ts` "Scenario: Unsigned answer" |
| answer-attestation: Attestation missing or false | `answer-intake.test.ts` "Scenario: Attestation missing or false" |
| answer-attestation: Confidence out of range | `answer-intake.test.ts` "Scenario: Confidence out of range" (0 and 6) |
| answer-attestation: Body does not match the intent | `answer-intake.test.ts` "Scenario: Body does not match the intent" (signed estimate body on a judgment request) |
| answer-attestation: Tampered body | `answer-intake.test.ts` "Scenario: Tampered body" |
| answer-attestation: Old key still verifies | `answer-intake.test.ts` "Scenario: Old key still verifies" (signed, then the stage rotates; accepted through the rotated `key_id`); `signing-keys.test.ts` (rotation at start) |
| answer-attestation: Revoked key | `answer-intake.test.ts` "Scenario: Revoked key", "an unknown key_id is rejected" |
| answer-attestation: Rejection log line | `answer-intake.test.ts` "Scenario: Rejection log line" (keys exactly `level`, `msg`, `request_id`, `code`; no body, no identity, no signature) |
| participant-simulation: Prompt answer | `simulate.test.ts` "Scenario: Prompt answer"; `worker-run.test.ts` (end to end through the queues) |
| participant-simulation: Decline | `simulate.test.ts` "Scenario: Decline" (reason code `outside_expertise`, no cleared amount, hold released, no answer) |
| participant-simulation: Can't tell | `simulate.test.ts` "Scenario: Can't tell" (verdict `cant_tell`, complete envelope) |
| participant-simulation: Silent until expiry | `simulate.test.ts` "Scenario: Silent until expiry" |
| participant-simulation: Scripted personas (slow; delays under two minutes) | `simulate.test.ts` "slow persona: accepts first, answers at its delay", "every persona acts within its delay" |
| participant-simulation: Verifies like a real answer | `simulate.test.ts` "Scenario: Verifies like a real answer" (canonical payload recomputed from stored fields, verified with the key named by `key_id`) |
| participant-simulation: Marked in discovery and in answers (worker side) | `simulate.test.ts` "Scenario: Marked in discovery and in answers" (answer's participant: `sim-` handle, "(simulated)" label, `simulated`; body text marked) |
| participant-simulation: Nothing on production | `worker-run.test.ts` "Scenario: Nothing on production" (no `simulate` or `deliver` queue, `expire` still there, nothing delivered); `env.test.ts` (STAGE=prod never enables the simulator) |
| participant-simulation: No outbound traffic | `worker-run.test.ts` "Scenario: Prompt answer, end to end ... with Scenario: No outbound traffic" (fetch, http and https mocked: zero calls; every socket opened goes to the stage database) and "Scenario: No outbound traffic (source)" (no mailer, HTTP client, AWS SDK or model client in `src/`) |
| design D3: jobs schema (task 5.1) | `worker.test.ts` (pg-boss tables in `pr_12_jobs`; `pr_12` holds only the Drizzle tables; nothing in `public`); `env.test.ts` (`DB_JOBS_SCHEMA` required, distinct from `DB_SCHEMA`) |
| design D4 amendment: stage key recorded at start | `signing-keys.test.ts` (first start active; restart no-op; new key rotates the previous platform key; participant keys untouched; a rotated key or a mismatched pair refused) |

Not covered here, by design: what `check_requests` shows (handle or label, `simulated: true`, cleared amount, signature display) is the mcp side (task 4.4) and the contract suite (7.1).
