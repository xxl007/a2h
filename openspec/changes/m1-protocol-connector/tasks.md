# Tasks: m1-protocol-connector

Owners: **PD** protocol-dev, **QA** qa, **PM** pm. One PR for the change (`feat(m1): protocol and connector with simulated participants`), built on branches per owner and merged by the PM into the PR branch, as in M0. Every task: failing test first (superpowers `test-driven-development`), then the code, then the test green. Specs referenced by capability name; design decisions by D-number.

## 1. Spike: approval round trip in Claude Code (PD, go/no-go before anything else)

- [x] 1.1 On a branch, add a throwaway tool `approve_test` to `apps/mcp` that returns an `input_required` result with one pre-filled string field and an HMAC `requestState` (D1), and on retry returns the accepted text; verify with the contract client (`@modelcontextprotocol/client` 2.4.0) locally that the retried call carries `inputResponses` and the echoed state
- [x] 1.2 Open a draft PR so the preview deploys; from this machine run `claude mcp add --transport http a2h-spike http://<alb>/pr-<n>/mcp` and ask Claude Code 2.1.226 to call `approve_test`; verify the dialog shows the pre-filled text, that editing and accepting returns the edited text, and that the mcp logs show the 2026-07-28 revision; paste the log lines (no bodies) into this file under "Spike result" and delete the tool before task 2 starts. If the client took the 2025 path, stop and report to the PM (fallback in design.md D1). Done 2026-10-28 on draft PR #24; print-mode evidence under "Spike result"; the owner chose option 1 on issue #14 without the interactive check, which happens at Gate 2 with the two environment variables

## 2. `packages/protocol` (PD)

- [x] 2.1 Zod 4 schemas for handle, profile, rules of engagement, manifest (intent, audience, time shape, format, data terms), request and status enum, per-intent answer bodies, answer envelope, `ProtocolError`, ledger entry, and the inputs/outputs of `find_humans`, `request_human`, `check_requests`; verify a passing and a failing fixture per schema (`protocol/schemas` "Fixture pair per schema")
- [x] 2.2 Money helpers `gross`, `net`, `clear` with `f` and `s` as arguments, rounding half-up once; verify the 2500/20% → 3125 example and a property test over shares 0..1 ("Gross from net rounds once", "Bounds hold for any share"); verify `bid_minor: 30.5` is rejected
- [x] 2.3 `canonicalAnswerPayload`; verify the reference string and key-order independence ("Canonical form of the reference answer")
- [x] 2.4 `signAnswer` / `verifyAnswer` on WebCrypto Ed25519 taking key material as arguments (D4); verify sign-then-verify, a one-character tamper fails, and a wrong key fails
- [x] 2.5 Id and handle formatters and parsers taking randomness as an argument; verify `7f3c` → `A2H-7f3c`, and that `A2H-7F3C` and `A2H-7f3` are rejected ("Identifier formats")
- [x] 2.6 `validateManifest(manifest, facts, policy)` implementing the ordered pipeline with the deterministic forbidden-content rule set (D6); verify one test per `protocol/request-approval` validation scenario (bid below reserve, push-poll, third-party personal data, labour disguised, quiet hours deferred and rejected, interruption budget) plus the lifecycle table test over every (state, actor, event) pair (`protocol/request-lifecycle` "Legal transitions", "Illegal transition")
- [x] 2.7 JSON Schema export (`z.toJSONSchema`) for every tool input and output with snapshot tests; verify the snapshots are committed and `pnpm --filter @a2h/protocol test` is green
- [x] 2.8 Build step: `tsconfig.build.json` emitting ESM to `dist/`, `exports` map, `pnpm --filter @a2h/protocol build` in Turborepo's pipeline (D5); verify a fresh clone builds and `node -e "import('@a2h/protocol')"` resolves from `dist/`
- [x] 2.9 Purity check: an ESLint rule (or a test) forbidding `node:` imports and `Date.now`/`Math.random` in the package; verify it fails on a deliberate violation and passes on the package ("The package performs no I/O")

## 3. Database (PD writes, QA tests the scripts)

- [x] 3.1 Drizzle schema in `packages/db`: `participants` (with `simulated`), `profiles`, `rules`, `requests`, `request_events`, `blocked_manifests` (codes only), `answers`, `signing_keys`, `schema_migrations`; verify `drizzle-kit generate` produces migration SQL that applies cleanly to Postgres 17 in Docker and that no column of `blocked_manifests` can hold text longer than a code
- [x] 3.2 Seed file for twelve simulated profiles and five personas (handles `sim-*`, labels ending "(simulated)"), applied idempotently by upsert on handle; verify applying twice leaves twelve rows (`platform/participant-simulation` "Redeploy")
- [x] 3.3 `.github/scripts/db-migrate.sh <stage>`: Data API, one transaction per file, `SET ROLE pr_<n>` on previews, `schema_migrations` tracking, seed on non-production stages (D2); verify with a `tests/ci/db-migrate.test.sh` against Docker Postgres (stubbed `aws`) including the `SET ROLE` ownership check and the fallback noted in design.md
- [x] 3.4 `pr-schema.sh`: also creates and drops `pr_<n>_jobs` (D3); verify `tests/ci/pr-schema*.test.sh` cover create, idempotent re-create and drop of both schemas. (Secrets are created by SST per stage, D4 amendment; the script no longer touches Secrets Manager beyond `a2h/pr-<n>/db`)

## 4. MCP tools (PD)

- [x] 4.1 `apps/mcp/infra/env.ts` database adapter mirroring the worker's, Drizzle over `pg` with the RDS CA bundle, pool sized for Fargate; verify a unit test of the adapter's validation and a startup test that refuses to start without `DB_CA_BUNDLE` when set
- [x] 4.2 `find_humans`: filters, ranking inputs and display string, gross prices with fee metadata, empty result with hint, no identity fields; verify one test per `protocol/discovery` scenario including "Nothing recorded for participants"
- [x] 4.3 `request_human` (D1, D7): validation → `input_required` with the one-field form and HMAC state → re-validation on retry → request created atomically with its first event; verify tests for accept-after-edit (byte-identical), decline, dismissed, forged or expired state (SDK `-32602` `invalid_request_state`), replayed state with changed arguments (`conflict`), edit-into-push-poll, return under one second, principal recorded, blocked row without content, and a client on the 2025 revision gets an `isError` result whose text says how to connect (decision 5: option 1)
- [x] 4.4 `check_requests` by id and by filter: status, transition timestamps, held and cleared amounts, envelope when answered, handle before acceptance and label after, `simulated` flag, `not_found` for unknown or foreign ids; verify one test per `protocol/request-lifecycle` and `protocol/answer-attestation` display scenario
- [x] 4.5 Tool descriptions carrying the policy text, `inputSchema`/`outputSchema` from the export, `structuredContent` plus text; verify the updated `mcp-transport` "Tools are listed" test and the schema-equality test ("Tool schemas come from the export")
- [x] 4.6 Structured logging with `request_id`, `principal_id`, `participant_id`, state, code and never text (D9); verify a test that captures log lines on the blocked and rejected paths and asserts no question or body text appears

## 5. Worker: lifecycle and simulator (PD)

- [x] 5.1 pg-boss in its own schema from `DB_JOBS_SCHEMA` (D3); verify the worker starts against a database where the jobs schema exists and `public`/`pr_<n>` hold only Drizzle tables
- [x] 5.2 `deliver` queue: re-validate against current rules (facts loaded from the database), write a blocked row and leave the request `sent` when it fails, otherwise enqueue `simulate` with the persona's delay; verify the "Rules changed after approval" test
- [x] 5.3 `simulate` queue: personas prompt, decline, slow, can't tell, silent; answer bodies per intent; envelopes signed with the stage key loaded from Secrets Manager (D4, D8), stored through the same verification path as a real answer; verify one test per persona scenario and "Verifies like a real answer"
- [x] 5.4 `expire` scheduled queue: `sent`/`accepted` past expiry → `expired`, idempotent; verify "Expiry by the platform" and "Idempotent replay"
- [x] 5.5 Answer intake: reject unsigned, unattested, out-of-range confidence, intent-mismatched bodies, revoked or unknown `key_id`; accept with a rotated key; verify one test per `protocol/answer-attestation` scenario and that rejection logs carry only `request_id` and `code`
- [x] 5.6 Simulator disabled and seed skipped on `prod`; verify a configuration test that `STAGE=prod` registers no `simulate` queue and that no outbound network call is made by the simulator (mocked fetch and mailer assert zero calls)

## 6. Infrastructure and CI (PD for `infra/`, QA for workflows)

- [x] 6.1 `infra/`: the mcp service gets database environment and secret like the worker; new secrets `a2h/<stage>/approval` (HMAC key, 32 random bytes) and `a2h/<stage>/signing` (Ed25519 private key) are created by SST for every stage, including previews, and wired as ECS secrets (D4 amendment); `DB_JOBS_SCHEMA`, `PRINCIPAL_*` policy and `FEE_RATE`/`CLEARING_SHARE` as plain environment from `infra/config.ts` (D7); verify `pnpm typecheck` and the `tests/ci/infra-consistency.test.sh` extended for the new variables
- [x] 6.2 Workflows: `db-migrate.sh` step after credentials and before `sst deploy` in `preview.yml` and `deploy.yml`; `pr-schema.sh drop` still last in teardown; verify `tests/ci/workflows.test.mjs` additions and `actionlint`
- [x] 6.3 Runbook `docs/runbooks/aws-bootstrap.md` §14: how the per-stage secrets are created by the deploy, how to rotate `a2h/<stage>/signing` (new key id, old key stays `rotated`) and `a2h/<stage>/approval` (pending approvals expire within 15 minutes); verify verify the documented commands are dry-run checked in `tests/ci/bootstrap.test.mjs`

## 7. Verification (QA)

- [ ] 7.1 Contract tests in `tests/contract` for every scenario of `protocol/discovery`, `protocol/request-approval`, `protocol/request-lifecycle`, `protocol/answer-attestation`, `platform/participant-simulation` and the modified `mcp-transport` scenario, driving the approval round trip with the v2 client; verify the scenario → test table in `tests/README.md` is complete and the suite is green against the PR's preview
- [ ] 7.2 Adversarial suite `tests/adversarial` with cases 1–6, 10 and 11 of the protocol skill (fail-closed expected); verify each case is red against a deliberately weakened validation and green against the PR's preview
- [ ] 7.3 Preview run of the Gate 2 script (proposal "How the product owner validates") from Claude Code against the PR's preview, with log excerpts (no bodies) posted on the PR; verify every step behaves as written

## 8. Review and gate (PM)

- [ ] 8.1 Cold review by the reviewer agent on the PR (blocks on missing tests, spec drift, the one rule); verify findings are resolved or recorded in this file
- [ ] 8.2 Gate 2 post: what shipped, preview URLs, the `claude mcp add` command, issues closed, deliberately not done; verify the owner's validation is recorded before archive

## Review findings (task 8.1, cold review of PR #26 at de252b5, 2026-10-29)

Verdict BLOCK on B1; fixed in a follow-up PR before Gate 2. Summary comment: PR #26, comment 6496989728.

- B1 (blocking, one rule, principal side): poll options and scale were stored and delivered but never shown at approval; attachments accepted. Fix: options and scale shown verbatim in the approval message; attachments, audiences other than a named individual and threaded or recurring time shapes refused with `schema_invalid` in this change. Spec scenarios "Options shown with the question" and "Shape outside this change" added.
- N1 out-of-scope shapes accepted: fixed with B1.
- N2 read-then-insert races on a participant's limits: recorded in design.md Risks, M3.
- N3 declined approval state usable until expiry: recorded in design.md Risks, M3.
- N4 behaviour without scenarios (client without forms, unverifiable stored answer hidden, only simulated participants delivered): scenarios added to the spec deltas.
- N5 "Send · hold €N" is message text: spec requirement reworded.
- N6 `ping` input schema inline rather than from the export: fixed with B1.
- N7 worker error logs include `error.message`: fixed with B1 (name and SQLSTATE code only; the worker's own `worker configuration:` messages are kept because they name a variable and never a value, PM decision).
- N8 assertion that cannot fail in `find-humans.test.ts`: fixed with B1.
- N9 stale docs (`tests/README.md` scenario name; PR #26 body): README fixed with B1; PR body rewritten by the PM at Gate 2.

## Workflow follow-up

- Archive with `/opsx:archive m1-protocol-connector` after Gate 2; the modified `mcp-transport` scenario merges into the main spec.
- Propose `m1-hosted-connector` (domain, TLS, authorization, rate limits, held-`ping` cap, hosted web client verification).

## Spike result

Task group 1, branch `spike/m1-approval-roundtrip` (never merged), draft PR #24, preview `pr-24`, commit `022bda1`. Recorded 2026-10-28 by Protocol-dev. No question or answer bodies below.

**Call: NO-GO for Claude Code 2.1.226 as installed (default settings); GO when two environment variables are set.** The PM and owner choose between D1's fallback and requiring the variables. 1.2 stays open until the owner's interactive check (PR #24, comment "Owner check").

Server side (1.1), `@modelcontextprotocol/client` 2.4.0, `apps/mcp/test/approve-test.spike.test.ts`:
- In-process, `pnpm --filter @a2h/mcp test`: `# tests 31`, `# pass 31`, `# fail 0`. This includes 10 spike tests: input_required with one pre-filled field; accept with an edit gives back the edit byte-identical; auto-fulfilling client; decline; cancel; tampered or foreign state refused; state replayed with other arguments gives `conflict`; no state gives `conflict`; state minted on instance A verifies on instance B (round-robin over two in-process servers); a 2025-era client gets an isError result and is never asked anything.
- Against the preview, `A2H_MCP_URL=http://<alb>/pr-24/mcp node --test test/approve-test.spike.test.ts`: `# tests 10`, `# pass 8`, `# fail 0`, `# skipped 2` (the two in-process-only cases). The preview runs one MCP task, so it does not exercise two instances. Only the in-process round-robin test does.
- `pnpm typecheck`, `pnpm lint`: 9/9 tasks successful. Preview run 40721154409: deploy and verify (smoke, contract, e2e) passed.

Claude Code 2.1.226, `claude -p` against `pr-24`. Wire headers come from a local logging proxy that recorded headers and method names only.
- Default: debug `mcp runtime arm: v1 (source: default)`. Wire: `initialize`, then `mcp-protocol-version: 2025-11-25` on every request. Handling: the tool result is an error, `Cannot request input 'approval' (elicitation/create): the client on this 2025-era connection did not declare the required capability (... per-request legacy serving cannot receive server-to-client requests)`. No dialog, nothing approved.
- `MCP_SDK_GENERATION=v2` alone: `mcp runtime arm: v2 (source: env)`, but `"protocolEra":"legacy","negotiatedProtocolVersion":"2025-11-25"`. Same error.
- `MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto`: `"protocolEra":"modern","negotiatedProtocolVersion":"2026-07-28"`. Wire: `server/discover` (2026-07-28), `tools/call` gets resultType `input_required`, then `tools/call` with `inputResponses` and `requestState` gets `complete`. Handling: Claude Code recognised the result and fulfilled it; print mode cannot show a form, so it answered `cancel`. The server verified the echoed state and returned `Not sent (cancel): nothing was created.` (`Tool 'approve_test' completed successfully in 241ms`).
- Why: in the 2.1.226 binary, HTTP servers negotiate `legacy` unless `MCP_PROTOCOL_NEGOTIATION=auto` or the remote flag `tengu_mcp_protocol_negotiation_http` is on. The v2 client runtime needs `MCP_SDK_GENERATION=v2` or the remote flag `tengu_brindle_causeway`. Both flags were off for this account. These are undocumented internals: they can change in any release, and another account may see different flag values.

SDK facts that differ from design.md D1 (for the PM):
- The SDK ships `createRequestStateCodec({ key, ttlSeconds, bind })`, an HMAC-SHA256 that is signed, not encrypted: the client can read the payload. Use it instead of hand-rolled HMAC. `bind` is the place for `principal_id`. The key must be at least 32 bytes.
- A state refused by `requestState.verify` never reaches the handler. The SDK answers with JSON-RPC `-32602` "Invalid or expired requestState", `data.reason: "invalid_request_state"`, and the message is fixed. So the "Altered approval state" scenario cannot return a tool error with code `conflict` from the hook. Either the spec accepts `-32602` for forged or expired state, or the hook resolves a marker instead of throwing and the handler returns `conflict`. In the spike, `conflict` covers only a valid state whose `manifest_hash` does not match the retried arguments, and a missing state.
- 2025-era clients on the stateless server: the SDK's legacy shim cannot send `elicitation/create` per request and returns an isError result. So D1's fallback (SDK sessions, one task) is the only way a default Claude Code 2.1.226 sees the dialog. That fallback is untested here.

