# Tasks: m1-protocol-connector

Owners: **PD** protocol-dev, **QA** qa, **PM** pm. One PR for the change (`feat(m1): protocol and connector with simulated participants`), built on branches per owner and merged by the PM into the PR branch, as in M0. Every task: failing test first (superpowers `test-driven-development`), then the code, then the test green. Specs referenced by capability name; design decisions by D-number.

## 1. Spike: approval round trip in Claude Code (PD, go/no-go before anything else)

- [ ] 1.1 On a branch, add a throwaway tool `approve_test` to `apps/mcp` that returns an `input_required` result with one pre-filled string field and an HMAC `requestState` (D1), and on retry returns the accepted text; verify with the contract client (`@modelcontextprotocol/client` 2.4.0) locally that the retried call carries `inputResponses` and the echoed state
- [ ] 1.2 Open a draft PR so the preview deploys; from this machine run `claude mcp add --transport http a2h-spike http://<alb>/pr-<n>/mcp` and ask Claude Code 2.1.226 to call `approve_test`; verify the dialog shows the pre-filled text, that editing and accepting returns the edited text, and that the mcp logs show the 2026-07-28 revision; paste the log lines (no bodies) into this file under "Spike result" and delete the tool before task 2 starts. If the client took the 2025 path, stop and report to the PM (fallback in design.md D1)

## 2. `packages/protocol` (PD)

- [x] 2.1 Zod 4 schemas for handle, profile, rules of engagement, manifest (intent, audience, time shape, format, data terms), request and status enum, per-intent answer bodies, answer envelope, `ProtocolError`, ledger entry, and the inputs/outputs of `find_humans`, `request_human`, `check_requests`; verify a passing and a failing fixture per schema (`protocol/schemas` "Fixture pair per schema")
- [x] 2.2 Money helpers `gross`, `net`, `clear` with `f` and `s` as arguments, rounding half-up once; verify the 2500/20% → 3125 example and a property test over shares 0..1 ("Gross from net rounds once", "Bounds hold for any share"); verify `bid_minor: 30.5` is rejected
- [ ] 2.3 `canonicalAnswerPayload`; verify the reference string and key-order independence ("Canonical form of the reference answer")
- [ ] 2.4 `signAnswer` / `verifyAnswer` on WebCrypto Ed25519 taking key material as arguments (D4); verify sign-then-verify, a one-character tamper fails, and a wrong key fails
- [ ] 2.5 Id and handle formatters and parsers taking randomness as an argument; verify `7f3c` → `A2H-7f3c`, and that `A2H-7F3C` and `A2H-7f3` are rejected ("Identifier formats")
- [ ] 2.6 `validateManifest(manifest, facts, policy)` implementing the ordered pipeline with the deterministic forbidden-content rule set (D6); verify one test per `protocol/request-approval` validation scenario (bid below reserve, push-poll, third-party personal data, labour disguised, quiet hours deferred and rejected, interruption budget) plus the lifecycle table test over every (state, actor, event) pair (`protocol/request-lifecycle` "Legal transitions", "Illegal transition")
- [ ] 2.7 JSON Schema export (`z.toJSONSchema`) for every tool input and output with snapshot tests; verify the snapshots are committed and `pnpm --filter @a2h/protocol test` is green
- [ ] 2.8 Build step: `tsconfig.build.json` emitting ESM to `dist/`, `exports` map, `pnpm --filter @a2h/protocol build` in Turborepo's pipeline (D5); verify a fresh clone builds and `node -e "import('@a2h/protocol')"` resolves from `dist/`
- [ ] 2.9 Purity check: an ESLint rule (or a test) forbidding `node:` imports and `Date.now`/`Math.random` in the package; verify it fails on a deliberate violation and passes on the package ("The package performs no I/O")

## 3. Database (PD writes, QA tests the scripts)

- [ ] 3.1 Drizzle schema in `packages/db`: `participants` (with `simulated`), `profiles`, `rules`, `requests`, `request_events`, `blocked_manifests` (codes only), `answers`, `signing_keys`, `schema_migrations`; verify `drizzle-kit generate` produces migration SQL that applies cleanly to Postgres 17 in Docker and that no column of `blocked_manifests` can hold text longer than a code
- [ ] 3.2 Seed file for twelve simulated profiles and five personas (handles `sim-*`, labels ending "(simulated)"), applied idempotently by upsert on handle; verify applying twice leaves twelve rows (`platform/participant-simulation` "Redeploy")
- [ ] 3.3 `.github/scripts/db-migrate.sh <stage>`: Data API, one transaction per file, `SET ROLE pr_<n>` on previews, `schema_migrations` tracking, seed on non-production stages (D2); verify with a `tests/ci/db-migrate.test.sh` against Docker Postgres (stubbed `aws`) including the `SET ROLE` ownership check and the fallback noted in design.md
- [ ] 3.4 `pr-schema.sh`: also creates and drops `pr_<n>_jobs` and the secret `a2h/pr-<n>/signing` (D3, D4); verify `tests/ci/pr-schema*.test.sh` cover create, idempotent re-create and drop of both schemas and the secret

## 4. MCP tools (PD)

- [ ] 4.1 `apps/mcp/infra/env.ts` database adapter mirroring the worker's, Drizzle over `pg` with the RDS CA bundle, pool sized for Fargate; verify a unit test of the adapter's validation and a startup test that refuses to start without `DB_CA_BUNDLE` when set
- [ ] 4.2 `find_humans`: filters, ranking inputs and display string, gross prices with fee metadata, empty result with hint, no identity fields; verify one test per `protocol/discovery` scenario including "Nothing recorded for participants"
- [ ] 4.3 `request_human` (D1, D7): validation → `input_required` with the one-field form and HMAC state → re-validation on retry → request created atomically with its first event; verify tests for accept-after-edit (byte-identical), decline, dismissed, altered state (`conflict`), edit-into-push-poll, return under one second, principal recorded, blocked row without content
- [ ] 4.4 `check_requests` by id and by filter: status, transition timestamps, held and cleared amounts, envelope when answered, handle before acceptance and label after, `simulated` flag, `not_found` for unknown or foreign ids; verify one test per `protocol/request-lifecycle` and `protocol/answer-attestation` display scenario
- [ ] 4.5 Tool descriptions carrying the policy text, `inputSchema`/`outputSchema` from the export, `structuredContent` plus text; verify the updated `mcp-transport` "Tools are listed" test and the schema-equality test ("Tool schemas come from the export")
- [ ] 4.6 Structured logging with `request_id`, `principal_id`, `participant_id`, state, code and never text (D9); verify a test that captures log lines on the blocked and rejected paths and asserts no question or body text appears

## 5. Worker: lifecycle and simulator (PD)

- [ ] 5.1 pg-boss in its own schema from `DB_JOBS_SCHEMA` (D3); verify the worker starts against a database where the jobs schema exists and `public`/`pr_<n>` hold only Drizzle tables
- [ ] 5.2 `deliver` queue: re-validate against current rules (facts loaded from the database), write a blocked row and leave the request `sent` when it fails, otherwise enqueue `simulate` with the persona's delay; verify the "Rules changed after approval" test
- [ ] 5.3 `simulate` queue: personas prompt, decline, slow, can't tell, silent; answer bodies per intent; envelopes signed with the stage key loaded from Secrets Manager (D4, D8), stored through the same verification path as a real answer; verify one test per persona scenario and "Verifies like a real answer"
- [ ] 5.4 `expire` scheduled queue: `sent`/`accepted` past expiry → `expired`, idempotent; verify "Expiry by the platform" and "Idempotent replay"
- [ ] 5.5 Answer intake: reject unsigned, unattested, out-of-range confidence, intent-mismatched bodies, revoked or unknown `key_id`; accept with a rotated key; verify one test per `protocol/answer-attestation` scenario and that rejection logs carry only `request_id` and `code`
- [ ] 5.6 Simulator disabled and seed skipped on `prod`; verify a configuration test that `STAGE=prod` registers no `simulate` queue and that no outbound network call is made by the simulator (mocked fetch and mailer assert zero calls)

## 6. Infrastructure and CI (PD for `infra/`, QA for workflows)

- [ ] 6.1 `infra/`: the mcp service gets database environment and secret like the worker; new secrets `a2h/<stage>/approval` (HMAC) and `a2h/<stage>/signing` wired as ECS secrets; `DB_JOBS_SCHEMA`, `PRINCIPAL_*` policy and `FEE_RATE`/`CLEARING_SHARE` as plain environment from `infra/config.ts` (D7); verify `pnpm typecheck` and the `tests/ci/infra-consistency.test.sh` extended for the new variables
- [ ] 6.2 Workflows: `db-migrate.sh` step after credentials and before `sst deploy` in `preview.yml` and `deploy.yml`; `pr-schema.sh drop` still last in teardown; verify `tests/ci/workflows.test.mjs` additions and `actionlint`
- [ ] 6.3 Runbook `docs/runbooks/aws-bootstrap.md` §14: create `a2h/dev/signing` and `a2h/dev/approval` once; rotation procedure; verify the documented commands are dry-run checked in `tests/ci/bootstrap.test.mjs`

## 7. Verification (QA)

- [ ] 7.1 Contract tests in `tests/contract` for every scenario of `protocol/discovery`, `protocol/request-approval`, `protocol/request-lifecycle`, `protocol/answer-attestation`, `platform/participant-simulation` and the modified `mcp-transport` scenario, driving the approval round trip with the v2 client; verify the scenario → test table in `tests/README.md` is complete and the suite is green against the PR's preview
- [ ] 7.2 Adversarial suite `tests/adversarial` with cases 1–6, 10 and 11 of the protocol skill (fail-closed expected); verify each case is red against a deliberately weakened validation and green against the PR's preview
- [ ] 7.3 Preview run of the Gate 2 script (proposal "How the product owner validates") from Claude Code against the PR's preview, with log excerpts (no bodies) posted on the PR; verify every step behaves as written

## 8. Review and gate (PM)

- [ ] 8.1 Cold review by the reviewer agent on the PR (blocks on missing tests, spec drift, the one rule); verify findings are resolved or recorded in this file
- [ ] 8.2 Gate 2 post: what shipped, preview URLs, the `claude mcp add` command, issues closed, deliberately not done; verify the owner's validation is recorded before archive

## Workflow follow-up

- Archive with `/opsx:archive m1-protocol-connector` after Gate 2; the modified `mcp-transport` scenario merges into the main spec.
- Propose `m1-hosted-connector` (domain, TLS, authorization, rate limits, held-`ping` cap, hosted web client verification).
