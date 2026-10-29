# tests

QA-owned suites for A2H. Every scenario in `openspec/specs` (and in the deltas of the change in flight) maps to a test listed below; a scenario without a test blocks its change.

| Folder | What | Runs |
|---|---|---|
| `ci/` | Tests of the CI scripts and workflows (stubbed `aws`, real Postgres 17 in Docker, parsed YAML, bootstrap JSON) and the smoke script (`preview-smoke.sh`, with its own test against a fake `curl`) | `ci.yml`: job `check`, step "Check CI scripts" (stubbed `aws`, YAML, JSON); job `scripts-pg` (the `.pg` and `db-migrate` tests on Postgres 17 in Docker, which fail instead of skipping there); the smoke script itself runs in the `verify` jobs |
| `contract/` | MCP contract tests against a live MCP endpoint (`@modelcontextprotocol/client` 2.4.0 pinned to 2026-07-28, `node:test`): transport, discovery, the approval round trip driven by hand (`a2h.ts`), the request flows with the simulated personas | in CI on every preview (`preview.yml`, job `verify pr-<n>`) and on `dev` after each deploy from `main` (`deploy.yml`, job `verify dev`); by hand against any stage. The idle-stream test stays opt-in, by hand |
| `adversarial/` | Adversarial suite (protocol skill §12, cases 1 to 6, 10, 11): `*.live.test.ts` against a live MCP endpoint, `*.local.test.ts` in-process against the worker's answer intake on Postgres 17 in Docker | live half: same `verify` jobs, step "Adversarial suite" (`pnpm --filter @a2h/tests adversarial`); in-process half: `ci.yml` job `check`, `pnpm test` (`A2H_DB_PG_REQUIRED=1`) |
| `local/stage.ts` | A local preview-like stage: Postgres 17 in Docker as a preview, the real MCP app at `/pr-12/mcp`, the real worker with the seed's persona delays; optional pinned MCP clock | by hand (`pnpm --filter @a2h/tests local-stage`), for running the live suites without a deploy and for the adversarial red runs |
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

# Adversarial suite, live half (cases 1 to 6, 10, 11 as seen from outside)
A2H_MCP_URL=http://<alb-dns>/pr-<n>/mcp pnpm --filter @a2h/tests adversarial
# Adversarial suite, in-process half (answer intake; needs Docker)
pnpm --filter @a2h/protocol --filter @a2h/db build && pnpm --filter @a2h/tests test

# A local stage instead of a deploy (prints A2H_MCP_URL; Ctrl-C removes the container)
pnpm --filter @a2h/protocol --filter @a2h/db build
pnpm --filter @a2h/tests local-stage
# ... with the MCP clock pinned at night (quiet hours), and the suites told so:
A2H_LOCAL_NOW=2026-10-29T23:00:00Z pnpm --filter @a2h/tests local-stage
A2H_MCP_URL=http://127.0.0.1:<port>/pr-12/mcp A2H_SERVER_NOW=2026-10-29T23:00:00Z pnpm --filter @a2h/tests adversarial

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
| `A2H_SERVER_NOW` | contract, adversarial | Only against a local stage started with `A2H_LOCAL_NOW`: the same instant, so the suites know the server's clock (quiet hours). Unset on deployed stages. |
| `A2H_LOCAL_NOW`, `A2H_LOCAL_PORT`, `A2H_LOCAL_QUIET` | local/stage.ts | Pin the MCP clock; fix the port; `1` silences the log lines. |

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
| Tool schemas come from the export | `json-schema.test.ts` (export of every tool input and output, ping's input included, committed snapshots in `packages/protocol/json-schema/`, closed top-level objects) | Equality with the schemas `tools/list` returns: 4.5, 7.1 |
| Fixture pair per schema | `schemas.test.ts` "Scenario: Fixture pair per schema" (one pair per exported schema, offending path asserted; a guard fails if a new schema has no pair) | - |
| Fractional amount rejected | `schemas.test.ts` "Scenario: Fractional amount rejected" | - |
| Gross from net rounds once, half up | `money.test.ts` "Scenario: Gross from net rounds once, half up" (2500 at 20% → 3125 → 2500, property test over f) | - |
| Bounds hold for any share | `money.test.ts` "Scenario: Bounds hold for any share" (share 0, 1 and a property test over [0, 1]) | - |
| Canonical form of the reference answer | `canonical.test.ts` (byte-for-byte reference string, key-order independence) | - |
| Request id from given randomness | `ids.test.ts` | - |
| Malformed id rejected | `ids.test.ts` (`A2H-7F3C`, `A2H-7f3` and others) | - |
| Works without any environment | `purity.test.ts` (every exported function in a child process where clock, randomness, network and timers throw, `--permission` with read-only fs); ESLint purity rules proven on deliberate violations | - |
| Request not sent | `schemas.test.ts` "Scenario: Request not sent" (`not_sent` with `declined` or `dismissed`, no `request_id`) | Tool: `apps/mcp/test/request-human.test.ts` "Scenario: Decline", "Scenario: Dismissed" |
| Free lane with a bid | `schemas.test.ts` "Scenario: Free lane with a bid" (fails on `bid_minor`, and only there) | - |

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
| Forged or expired approval state | - (refused by the SDK's `requestState.verify` hook before any handler, `-32602 invalid_request_state`) | `apps/mcp/test/request-human.test.ts` "Scenario: Forged or expired approval state" (group 4 table below) |
| Approval state replayed with changed arguments | `validate.test.ts` "Approval binding: conflict on a replayed approval with different arguments"; `manifest-hash.test.ts` | `apps/mcp/test/request-human.test.ts` "Scenario: Approval state replayed with changed arguments" (group 4 table below) |
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
| Accepted approval replayed | `request-human.test.ts` "Scenario: Accepted approval replayed" (same state, arguments and accept: `conflict` "already used", one request, one event, no blocked row, first request row unchanged; a fresh approval may still send); "Accepted approval replayed in parallel" (four concurrent retries: exactly one `sent`); database side: `packages/db/test/constraints.test.ts` "Accepted approval replayed: an approval nonce creates one request only" (unique `requests.approval_nonce`, nulls allowed, 32 lower-case hex only) |
| Options shown with the question | "Scenario: Options shown with the question" (every option id and label and the scale in the message verbatim, message ends with "Send · hold €N", stored values equal); "An option label never reaches a request without appearing in the approval message" (changed or added options on retry: `conflict`; every stored label was shown); "An option label is re-validated on retry like the question" |
| Shape outside this change | "Scenario: Shape outside this change: …" (six tests: attachments; audience `panel_sample`, `population_in_place`, `role_qualified_first_to_accept`; time shape `threaded`, `recurring`: `schema_invalid` naming the field and M3, nothing created) |
| Client without forms | "A 2026-07-28 client that cannot show a form is told so, and nothing is created" |
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
| Stored answer that no longer verifies | `check-requests.test.ts` "Scenario: Stored answer that no longer verifies" (key revoked after the answer was stored: envelope not shown, `answer_unverified` by id, left out of lists); "A stored answer whose body differs from what was signed is not shown either" |
| Old key still verifies (display) | "Scenario: Old key still verifies" (answer signed with a rotated key is shown) |
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

### platform/participant-simulation, delivery gate (`apps/worker/test/deliver.test.ts`)

| Scenario | Test |
|---|---|
| Only simulated participants are delivered | "Scenario: Only simulated participants are delivered" (a request to a participant that is not simulated gets no deliver job, no delivery row and no blocked row, stays `sent`, then expires) |

## Scenario to test map: m1-protocol-connector (complete, task 7.1)

The one table for the whole change: every scenario of `openspec/changes/m1-protocol-connector/specs/**`, the test that proves it and the suite it runs in. The per-group tables above give the detail of each package test; this table is the map a reviewer checks against. Scenarios that cannot be observed from outside a deployed stage (rows, logs, another principal, the server's clock, production) are proven by the package or in-process tests named here; their live test, where one exists, checks the observable part only and says so in its name.

Suites: **contract** = `tests/contract`, live, `verify` jobs of `preview.yml` and `deploy.yml`; **adversarial** = `tests/adversarial/*.live.test.ts`, live, same jobs; **adversarial (in-process)** = `tests/adversarial/*.local.test.ts`, `ci.yml` `pnpm test`; **package** = the package's `node --test` suite, `ci.yml` `pnpm test` (database tests on Postgres 17 in Docker, `A2H_DB_PG_REQUIRED=1`); **CI scripts** = `tests/ci`, `ci.yml`.

| Spec | Scenario | Live test | Package or in-process test | Suites |
|---|---|---|---|---|
| platform/mcp-transport | Initialize from a fresh client | `contract/mcp-transport.test.ts` "Scenario: Initialize from a fresh client" | `apps/mcp/test/mcp-transport.test.ts` | contract, package |
| platform/mcp-transport | Tools are listed | `contract/mcp-transport.test.ts` "Scenario: Tools are listed" (four tools, policy text) | `apps/mcp/test/mcp-transport.test.ts` "[legacy]/[modern] Tools are listed" | contract, package |
| platform/participant-simulation | Seed on a preview | `contract/discovery.test.ts` "Scenario: Seed on a preview" (all twelve found by their topic) | `ci/db-migrate.test.sh` (seed on previews) | contract, CI scripts |
| platform/participant-simulation | Only simulated participants are delivered | none: no stage holds a participant that is not simulated | `apps/worker/test/deliver.test.ts` "Scenario: Only simulated participants are delivered…"; `adversarial/delivery.local.test.ts` (also a forged deliver job delivers nothing) | package, adversarial (in-process) |
| platform/participant-simulation | Nothing on production | none: no `prod` stage exists | `apps/worker/test/worker-run.test.ts` "Scenario: Nothing on production", `env.test.ts`; `packages/db/test/seed.test.ts` "never on prod"; `ci/db-migrate.test.sh` section 8 | package, CI scripts |
| platform/participant-simulation | Marked in discovery and in answers | `contract/discovery.test.ts` "Scenario: Marked in discovery and in answers (discovery side…)"; `contract/request-flows.test.ts` "Scenario: Marked in discovery and in answers (answer side)" | `packages/db/test/constraints.test.ts` "Simulation is unmistakable"; `apps/worker/test/simulate.test.ts` | contract, package |
| platform/participant-simulation | Prompt answer | `contract/request-flows.test.ts` "Scenario: Prompt answer" (sim-jw-9e48, real delays, bound 80 s) | `apps/worker/test/simulate.test.ts`, `worker-run.test.ts` | contract, package |
| platform/participant-simulation | Decline | `contract/request-flows.test.ts` "Scenario: Decline" (sim-dm-7b80: `declined`, hold released, nothing cleared) | `apps/worker/test/simulate.test.ts` "Scenario: Decline" (the reason code, which check_requests does not show) | contract, package |
| platform/participant-simulation | Can't tell | `contract/request-flows.test.ts` "Scenario: Can't tell" (sim-ag-3b62, verification, verdict `cant_tell`) | `apps/worker/test/simulate.test.ts` "Scenario: Can't tell" | contract, package |
| platform/participant-simulation | Silent until expiry | `contract/request-flows.test.ts` "Scenario: Silent until expiry (with Scenario: Expiry by the platform, live)" (sim-hb-1f7d, expiry = latency promise + 60 s; skipped, with the reason, while the seed gives it a promise over 15 min: the review fix of #26 shortens it) | `apps/worker/test/simulate.test.ts` "Scenario: Silent until expiry"; `expire.test.ts` | contract, package |
| platform/participant-simulation | Verifies like a real answer | `contract/request-flows.test.ts` "Scenario: Verifies like a real answer (observable part)" (only verified answers are shown; the public key is not exposed) | `apps/worker/test/simulate.test.ts` "Scenario: Verifies like a real answer" | contract, package |
| platform/participant-simulation | Redeploy | `contract/discovery.test.ts` "Scenario: Redeploy" (each handle once; the preview redeploys on every push) | `packages/db/test/seed.test.ts` "Scenario: Redeploy"; `ci/db-migrate.test.sh` section 3 | contract, package, CI scripts |
| platform/participant-simulation | No outbound traffic | none: not observable from outside | `apps/worker/test/worker-run.test.ts` "…with Scenario: No outbound traffic", "Scenario: No outbound traffic (source)" | package |
| protocol/answer-attestation | Unsigned answer | `adversarial/answers.live.test.ts` (no answer shown without a signature) | `adversarial/answers.local.test.ts` "case 10" (14 forgeries); `apps/worker/test/answer-intake.test.ts` "Scenario: Unsigned answer" | adversarial, adversarial (in-process), package |
| protocol/answer-attestation | Attestation missing or false | `adversarial/answers.live.test.ts` | `adversarial/answers.local.test.ts` "case 11" (removed, false, "true", 1, null; also validly signed); `apps/worker/test/answer-intake.test.ts` | adversarial, adversarial (in-process), package |
| protocol/answer-attestation | Confidence out of range | `adversarial/answers.live.test.ts` (shown answers: 1 to 5) | `apps/worker/test/answer-intake.test.ts` "Scenario: Confidence out of range"; `packages/db/test/constraints.test.ts` | adversarial, package |
| protocol/answer-attestation | Body does not match the intent | `contract/request-flows.test.ts` "Scenario: Prompt answer", "Scenario: Can't tell" (bodies parsed for their intent) | `apps/worker/test/answer-intake.test.ts` "Scenario: Body does not match the intent" | contract, package |
| protocol/answer-attestation | Tampered body | none: no answer intake is reachable from outside in M1 | `apps/worker/test/answer-intake.test.ts` "Scenario: Tampered body"; `adversarial/answers.local.test.ts` "body changed after signing"; `packages/protocol/test/signing.test.ts` | adversarial (in-process), package |
| protocol/answer-attestation | Old key still verifies | none: rotation is not provoked on a stage from outside | `apps/worker/test/answer-intake.test.ts` "Scenario: Old key still verifies"; `apps/mcp/test/check-requests.test.ts` | package |
| protocol/answer-attestation | Revoked key | none | `apps/worker/test/answer-intake.test.ts` "Scenario: Revoked key"; `adversarial/answers.local.test.ts` "case 10: an answer signed with a revoked key"; `apps/mcp/test/check-requests.test.ts` | adversarial (in-process), package |
| protocol/answer-attestation | Display of the reference answer | `contract/request-flows.test.ts` "Scenario: Display of the reference answer" (`a2h:sig:…` + last four, `reviewed by J.W., <date>`, no notice for a verified participant); "slow persona … not-yet-verified notice" (sim-cf-4c5e) | `apps/mcp/test/check-requests.test.ts` "Scenario: Display of the reference answer"; `packages/protocol/test/display.test.ts` | contract, package |
| protocol/answer-attestation | Stored answer that no longer verifies | none: a key cannot be revoked from outside | `apps/mcp/test/check-requests.test.ts` "Scenario: Stored answer that no longer verifies…" (by id: `answer_unverified`; left out of lists) | package |
| protocol/answer-attestation | Rejection log line | none: CloudWatch is not read by the suites | `apps/worker/test/answer-intake.test.ts` "Scenario: Rejection log line"; `adversarial/answers.local.test.ts` "rejections are logged with the request id and the code only" | adversarial (in-process), package |
| protocol/discovery | Result shape | `contract/discovery.test.ts` "Scenario: Result shape" | `apps/mcp/test/find-humans.test.ts`; `packages/protocol/test/schemas.test.ts` | contract, package |
| protocol/discovery | Display string matches the fields | `contract/discovery.test.ts` "Scenario: Display string matches the fields" | `apps/mcp/test/find-humans.test.ts`; `packages/protocol/test/display.test.ts` | contract, package |
| protocol/discovery | Maximum price excludes a profile | `contract/discovery.test.ts` "Scenario: Maximum price excludes a profile" | `apps/mcp/test/find-humans.test.ts` | contract, package |
| protocol/discovery | Attested only | `contract/discovery.test.ts` "Scenario: Attested only" | `apps/mcp/test/find-humans.test.ts` | contract, package |
| protocol/discovery | Empty result | `contract/discovery.test.ts` "Scenario: Empty result" | `apps/mcp/test/find-humans.test.ts` | contract, package |
| protocol/discovery | Nothing recorded for participants | `contract/discovery.test.ts` "Scenario: Nothing recorded for participants (observable part…)" (no request for the handles found) | `apps/mcp/test/find-humans.test.ts` (no request, event, blocked or answer row, no job) | contract, package |
| protocol/discovery | Gross reserve with fee metadata | `contract/discovery.test.ts` "Scenario: Gross reserve with fee metadata" | `apps/mcp/test/find-humans.test.ts`; `packages/protocol/test/money.test.ts` | contract, package |
| protocol/request-approval | Bid below reserve | `contract/request-approval.test.ts` "Scenario: Bid below reserve"; `adversarial/manifest.live.test.ts` "case 6" (seven variants, a lowered bid on the retry) | `apps/mcp/test/request-human.test.ts`; `packages/protocol/test/validate.test.ts` | contract, adversarial, package |
| protocol/request-approval | Shape outside this change | `contract/request-approval.test.ts` "Scenario: Shape outside this change" (two audiences, threaded, recurring, attachments: `schema_invalid` naming the field and a milestone, no approval) | `apps/mcp/test/request-human.test.ts` "Scenario: Shape outside this change: …" | contract, package |
| protocol/request-approval | Push-poll | `contract/request-approval.test.ts` "Scenario: Push-poll"; `adversarial/manifest.live.test.ts` "case 1" | `apps/mcp/test/request-human.test.ts`; `packages/protocol/test/content-rules.test.ts` | contract, adversarial, package |
| protocol/request-approval | Third-party personal data | `contract/request-approval.test.ts` "Scenario: Third-party personal data"; `adversarial/manifest.live.test.ts` "case 2" | `apps/mcp/test/request-human.test.ts`; `packages/protocol/test/content-rules.test.ts` | contract, adversarial, package |
| protocol/request-approval | Labour disguised as a question | `contract/request-approval.test.ts` "Scenario: Labour disguised as a question"; `adversarial/manifest.live.test.ts` "case 3" | `apps/mcp/test/request-human.test.ts`; `packages/protocol/test/content-rules.test.ts` | contract, adversarial, package |
| protocol/request-approval | Quiet hours | `contract/request-approval.test.ts` "Scenario: Quiet hours" and `adversarial/manifest.live.test.ts` "case 4": the branch follows the server's clock (by day: delivery now only; 22:00 to 07:00 London: deferred, and refused with `retryable: true`); local stage with a pinned clock | `apps/mcp/test/request-human.test.ts` "Scenario: Quiet hours" (pinned clock); `packages/protocol/test/validate.test.ts` | contract, adversarial, package |
| protocol/request-approval | Interruption budget exceeded | `contract/request-approval.test.ts` "Scenario: Interruption budget exceeded"; `adversarial/manifest.live.test.ts` "case 5" (approvals minted before the budget ran out) | `apps/mcp/test/request-human.test.ts` (blocked row `interruption_budget`) | contract, adversarial, package |
| protocol/request-approval | Accept after editing | `contract/request-flows.test.ts` "Scenario: Accept after editing" (one request created) | `apps/mcp/test/request-human.test.ts` (stored bytes equal the edit; check_requests does not return the question) | contract, package |
| protocol/request-approval | Options shown with the question | `contract/request-approval.test.ts` "Scenario: Options shown with the question (the approval message…)" (each option label and the scale, verbatim) | `apps/mcp/test/request-human.test.ts` "Scenario: Options shown with the question…" (accept stores exactly those values; check_requests does not return them) | contract, package |
| protocol/request-approval | Decline | `contract/request-approval.test.ts` "Scenario: Decline" | `apps/mcp/test/request-human.test.ts` | contract, package |
| protocol/request-approval | Dismissed | `contract/request-approval.test.ts` "Scenario: Dismissed" | `apps/mcp/test/request-human.test.ts` | contract, package |
| protocol/request-approval | Forged or expired approval state | `contract/request-approval.test.ts` "Scenario: Forged or expired approval state (forged and altered…)" | `apps/mcp/test/request-human.test.ts` (also the genuine state after fifteen minutes) | contract, package |
| protocol/request-approval | Approval state replayed with changed arguments | `contract/request-approval.test.ts` "Scenario: Approval state replayed with changed arguments"; `adversarial/manifest.live.test.ts` cases 1 to 3 and 6 (swaps on the retry) | `apps/mcp/test/request-human.test.ts` | contract, adversarial, package |
| protocol/request-approval | Accepted approval replayed | `contract/request-flows.test.ts` "Scenario: Accepted approval replayed" (`conflict`, one request, first request unchanged) | `apps/mcp/test/request-human.test.ts` "Scenario: Accepted approval replayed", "…in parallel"; `packages/db/test/constraints.test.ts` (unique `requests.approval_nonce`) | contract, package |
| protocol/request-approval | Client on an older revision | `contract/request-approval.test.ts` "Scenario: Client on an older revision" | `apps/mcp/test/request-human.test.ts` | contract, package |
| protocol/request-approval | Client without forms | `contract/request-approval.test.ts` "Scenario: Client without forms" | `apps/mcp/test/request-human.test.ts` "A 2026-07-28 client that cannot show a form is told so…" | contract, package |
| protocol/request-approval | Edit turns the question into a push-poll | `contract/request-approval.test.ts` "Scenario: Edit turns the question into a push-poll"; `adversarial/manifest.live.test.ts` cases 1 to 3 (every forbidden question through the form) | `apps/mcp/test/request-human.test.ts` | contract, adversarial, package |
| protocol/request-approval | Return under a second | `contract/request-flows.test.ts` "Scenario: Return under a second" (accepting call timed from the client, network included) | `apps/mcp/test/request-human.test.ts` | contract, package |
| protocol/request-approval | Principal recorded | `contract/request-flows.test.ts` "Scenario: Principal recorded (observable part)"; a stage has one principal (D7) | `apps/mcp/test/request-human.test.ts` "Scenario: Principal recorded" (another principal gets `not_found`) | contract, package |
| protocol/request-approval | Blocked row | none: rows are not visible from outside | `apps/mcp/test/request-human.test.ts` "Scenario: Blocked row"; `packages/db/test/schema.test.ts`, `constraints.test.ts` | package |
| protocol/request-lifecycle | Legal transitions | `contract/request-flows.test.ts` "Scenario: Legal transitions (observed…)" (sent → accepted → answered; sent → declined in "Scenario: Decline") | `packages/protocol/test/lifecycle.test.ts`; `packages/db/test/constraints.test.ts`; `apps/worker/test/simulate.test.ts`, `expire.test.ts` | contract, package |
| protocol/request-lifecycle | Illegal transition | none: no tool causes a transition from outside in M1 | `packages/protocol/test/lifecycle.test.ts`; `packages/db/test/constraints.test.ts` | package |
| protocol/request-lifecycle | Idempotent replay | none | `apps/worker/test/expire.test.ts`, `answer-intake.test.ts` "Scenario: Idempotent replay"; `packages/db/test/constraints.test.ts` | package |
| protocol/request-lifecycle | Expiry by the platform | `contract/request-flows.test.ts` "Scenario: Silent until expiry (with Scenario: Expiry by the platform, live)" (`expired` within 90 s of the expiry, hold released; runs once sim-hb-1f7d's promise is short) | `apps/worker/test/expire.test.ts` "Scenario: Expiry by the platform"; `apps/mcp/test/check-requests.test.ts` (display) | contract, package |
| protocol/request-lifecycle | Rules changed after approval | none: rules cannot be changed from outside | `apps/worker/test/deliver.test.ts` "Scenario: Rules changed after approval" | package |
| protocol/request-lifecycle | Before acceptance | `contract/request-flows.test.ts` "Scenario: Before acceptance" | `apps/mcp/test/check-requests.test.ts` | contract, package |
| protocol/request-lifecycle | After acceptance | `contract/request-flows.test.ts` "Scenario: After acceptance" (slow persona sim-cf-4c5e, seen `accepted`) | `apps/mcp/test/check-requests.test.ts` | contract, package |
| protocol/request-lifecycle | Answered request | `contract/request-flows.test.ts` "Scenario: Answered request" | `apps/mcp/test/check-requests.test.ts` | contract, package |
| protocol/request-lifecycle | Filter by status | `contract/request-flows.test.ts` "Scenario: Filter by status" | `apps/mcp/test/check-requests.test.ts` | contract, package |
| protocol/request-lifecycle | Unknown id | `contract/request-flows.test.ts` "Scenario: Unknown id" | `apps/mcp/test/check-requests.test.ts` | contract, package |
| protocol/request-lifecycle | Atomic transition | none | `apps/worker/test/answer-intake.test.ts` "Scenario: Atomic transition" | package |
| protocol/schemas | Tool schemas come from the export | `contract/mcp-transport.test.ts` "Scenario: Tool schemas come from the export (deployed stage)" | `apps/mcp/test/mcp-transport.test.ts`; `packages/protocol/test/json-schema.test.ts` | contract, package |
| protocol/schemas | Fixture pair per schema | none | `packages/protocol/test/schemas.test.ts` | package |
| protocol/schemas | Fractional amount rejected | `adversarial/manifest.live.test.ts` "case 6" (a fractional bid is `schema_invalid`) | `packages/protocol/test/schemas.test.ts` | adversarial, package |
| protocol/schemas | Gross from net rounds once, half up | `contract/discovery.test.ts` "Scenario: Gross reserve with fee metadata" (2500 → 3125) | `packages/protocol/test/money.test.ts` | contract, package |
| protocol/schemas | Bounds hold for any share | `contract/request-flows.test.ts` "Scenario: Answered request" (reserve ≤ cleared ≤ bid) | `packages/protocol/test/money.test.ts` | contract, package |
| protocol/schemas | Canonical form of the reference answer | none | `packages/protocol/test/canonical.test.ts` | package |
| protocol/schemas | Request id from given randomness | none | `packages/protocol/test/ids.test.ts` | package |
| protocol/schemas | Malformed id rejected | none | `packages/protocol/test/ids.test.ts` | package |
| protocol/schemas | Request not sent | `contract/request-approval.test.ts` "Scenario: Decline", "Scenario: Dismissed" (the result parses with `status: "not_sent"`, a reason, no id) | `packages/protocol/test/schemas.test.ts` "Scenario: Request not sent…" | contract, package |
| protocol/schemas | Free lane with a bid | none | `packages/protocol/test/schemas.test.ts` "Scenario: Free lane with a bid: schema validation fails on bid_minor" | package |
| protocol/schemas | Works without any environment | none | `packages/protocol/test/purity.test.ts` | package |

### Live suites and the stage they run on

- A stage has one principal (`dev-principal-<stage>`, design D7) with a monthly budget of €500, a per-request cap of €60 and 50 requests a day. The live suites share it with the owner. `contract/request-flows.test.ts` creates four requests a run: the prompt (€7.75 cleared), decline (released), slow (€8.88 cleared) and can't-tell (€37.50 cleared) flows. `contract/request-approval.test.ts` and `adversarial/manifest.live.test.ts` create at most two a UTC day (sim-bk-2e6f's interruption budget; held a day, then released at expiry). Everything else is refused or declined before anything is created.
- Budget guard (`contract/a2h.ts`): a flow is skipped, with the reason in the report, when it would leave the owner less than €150 or 15 requests on the stage that month or day. A skipped flow is a skip, not a pass.
- "Nothing is created" is checked through `check_requests` (no new request to the handle used since the test started). The handles the refusal tests use are never sent to by the flows.
- Quiet hours (`sim-ep-5c07`, 22:00 to 07:00 London): a deployed stage's clock cannot be set, so by day the deferred and refused branches are not observable live; they run at night, on the local stage with `A2H_LOCAL_NOW` and `A2H_SERVER_NOW`, and in the package tests.
- Silent persona and expiry: a participant's latency promise is the shortest expiry its rules accept. sim-hb-1f7d gets the shortest promise the validation allows (review fix of #26), and the flows test then watches "Silent until expiry" live with an expiry of the promise plus 60 s; until then that test is skipped with the reason.

## Adversarial suite (task 7.2)

Cases from the protocol skill §12. Each was first shown red against a deliberately weakened validation, on the local stage (`local/stage.ts`, MCP clock pinned at 2026-10-29T23:00Z) or in-process, with a one-line `sed` patch applied to the source, run, then reverted with `git checkout` (never committed). Then green unpatched, locally and against the preview.

| Case | Test | Weakening used for the red run | Red result |
|---|---|---|---|
| 1 push-poll | `manifest.live.test.ts` "case 1" (7 phrasings; first leg, a second participant, the approval form, a swap on the retry) | W1: content stage off in `packages/protocol/src/validate.ts` (`classifyForbiddenContent` not called) | approval shown for a push-poll |
| 2 third-party personal data | "case 2" (6 phrasings, same paths) | W1 | approval shown |
| 3 labour disguised | "case 3" (5 phrasings, same paths) | W1 | approval shown |
| 4 quiet hours | "case 4" (deferred never now; expiries 12 h and 23 h refused, retryable, nothing revealed) | W4: quiet hours ignored | "Delivery: now" inside quiet hours |
| 5 over-interruption | "case 5" (three approvals minted, then redeemed; a fourth first leg) | W5: interruption budget not checked | 3 requests created past a budget of 2 |
| 6 bid below reserve | "case 6" (reserve − 1, the net reserve, 0, an undeclared free lane, negative, fractional, string; a lowered bid on the retry) | W6: reserve and free-lane checks off | approval shown at reserve − 1 |
| 10 unsigned answer | `answers.local.test.ts` "case 10" (14 forgeries) and "revoked key"; `answers.live.test.ts` | W10: signature not verified in `apps/worker/src/intake.ts` | a zero signature accepted |
| 11 answer without attestation | `answers.local.test.ts` "case 11" (10 forgeries, some validly signed); `answers.live.test.ts` | W11: intake coerces `answered_personally: true` before parsing | attestation removed after signing, accepted |

`manifest.live.test.ts` also carries six `todo` tests: evasions the deterministic content rules (design D6; the method is OPEN until M3) let through today (zero-width space, a Cyrillic letter, indirect wording, a polite question without an imperative, a named person with a specific disease, a deliverable missing from the word list). They report without failing the run.
