# Tasks: m0-foundation

Steps 1–3 are done and approved (issues #1–#3 closed, 2026-10-21). This file covers steps 4 and 5. Owner per task is the agent role; every task names its acceptance. Nothing in this change is deployed by an agent.

## Step 4: infrastructure as code and delivery pipeline (issue #4)

Contract between the two owners (fixed by the PM; change it only through the PM):

- SST app name `a2h`, `home: "aws"`, region `eu-west-3`, SST pinned to the current 4.x line (the Ion component API; see ADR 0001 amendment note in the PR).
- Stages: `dev` (long-lived, deployed from `main`), `pr-<n>` (ephemeral, one per pull request), `prod` (defined, never deployed in M0, `protect: true`).
- Shared resources are created by `dev` and reused by `pr-*` through the components' `static get`: VPC, ECS cluster, ALB, Aurora cluster, uploads bucket, SES identity. `dev` publishes their identifiers as SSM parameters under `/a2h/shared/`: `vpc-id`, `cluster-id`, `alb-arn`, `aurora-cluster-id`, `aurora-cluster-arn`, `aurora-secret-arn`, `uploads-bucket`, `email-sender`. `pr-*` stages read them at deploy time.
- Database `a2h` on the shared Aurora cluster. Schema per stage: `public` for `dev`, `pr_<n>` for `pr-<n>`. The schema is created before `sst deploy` and dropped after `sst remove` (amendment 1) by the workflows through the RDS Data API (`aws rds-data execute-statement`), using the two Aurora ARNs above. Services receive `DB_SCHEMA` and connect with a search path limited to it.
- Routing on the shared ALB: `dev` MCP at `/mcp` (health `/healthz`), `pr-<n>` MCP at `/pr-<n>/mcp` (health `/pr-<n>/healthz`). Services receive `MCP_BASE_PATH`. Listener-rule priorities: `dev` 49000, `pr-<n>` = 100 + n.
- `sst deploy` outputs (`.sst/outputs.json`): `stage`, `web` (web URL), `mcp` (full MCP endpoint URL).
- GitHub repository **variables** (not secrets): `AWS_DEV_ROLE_ARN`, `AWS_PREVIEW_ROLE_ARN` (amendment 1), `A2H_DEPLOY_ENABLED` (`true` only after the owner's bootstrap). No AWS key ever appears in GitHub secrets.
- GitHub repository **variables** (not secrets): `AWS_DEV_ROLE_ARN`, `AWS_PREVIEW_ROLE_ARN`, `A2H_DEPLOY_ENABLED` (`true` only after the owner's bootstrap). No AWS key ever appears in GitHub secrets.

### Contract amendment 1 (after the cold review of PR #6, 2026-10-21)

- **Two deploy roles, neither named `a2h-*`.** `gha-a2h-dev` is trusted only for `repo:xxl007/a2h:ref:refs/heads/main` (push to main and `workflow_dispatch` on main): `deploy.yml` uses it. `gha-a2h-preview` is trusted only for `repo:xxl007/a2h:pull_request`: `preview.yml` and `teardown.yml` use it. Policies in `infra/bootstrap/`.
- **Permissions boundary on every workload role.** The deploy roles may create or modify `role/a2h-*` only when the role carries the boundary `arn:aws:iam::<account>:policy/a2h-workload-boundary`, which denies all IAM and STS role assumption. `sst.config.ts` applies it to every `aws.iam.Role` through a global `$transform`. The boundary ARN is built from the caller's account ID, not hard-coded.
- **Per-PR database login.** `pr-schema.sh create <n>` creates or reuses the Secrets Manager secret `a2h/pr-<n>/db` (`{"username":"pr_<n>","password":…}`, random password, value masked in logs). It then creates or updates login role `pr_<n>`, creates schema `pr_<n>` with `AUTHORIZATION pr_<n>`, revokes `CREATE` and `USAGE` on schema `public` and `CONNECT` on database `a2h` from `PUBLIC`, grants `CONNECT` to `pr_<n>`, and sets the role's `search_path` to `pr_<n>`. On Aurora the master user is not a superuser, so PostgreSQL 17 also needs `GRANT pr_<n> TO CURRENT_USER` before `CREATE SCHEMA … AUTHORIZATION`, and `DROP OWNED BY pr_<n>` before `DROP ROLE` (found by QA against a real `postgres:17`). The `pr-<n>` stage injects `DB_USER=pr_<n>` and `DB_PASSWORD` from that secret, and **never** the master credentials. `dev` keeps the master user for M0.
- **Teardown order is reversed:** `sst remove --stage pr-<n>` first, then `pr-schema.sh drop <n>`. The drop terminates the remaining `pr_<n>` sessions, drops the schema with `CASCADE`, drops the role, and deletes the secret without recovery. Teardown still attempts the drop if `remove` fails.
- **Scoped storage on previews.** `pr-*` stages do not `link` the uploads bucket. They get `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `uploads/pr-<n>/*` and `tmp/pr-<n>/*` only, plus env `UPLOADS_BUCKET`.
- **Deploys wait for health:** every Service sets `wait: true`, so an unhealthy deploy fails the job.
- **No resurrection after close:** `preview.yml` re-reads the PR state immediately before `sst deploy` and skips if it is not open.
- **Supply chain:** actions in jobs holding `id-token: write` are pinned by commit SHA with the tag in a comment. `actions/checkout` uses `persist-credentials: false`. Deploy and teardown skip `dependabot[bot]`. CI runs `actionlint`.
- **Lint is real before Gate 2:** task 4.11.


| # | Task | Owner | Acceptance |
|---|---|---|---|
| 4.1 | `sst.config.ts` at the repo root (thin), stacks in `infra/` (`vpc`, `database`, `email`, `storage`, `cluster`, `mcp`, `worker`, `web`, `shared`), stage logic as in the contract | protocol-dev | `pnpm typecheck` passes from a clean checkout without AWS credentials; `sst diff`/deploy are **not** run |
| 4.2 | `apps/mcp/Dockerfile`, `apps/worker/Dockerfile`: multi-stage, Node 22, arm64-compatible, non-root, pnpm workspace-aware; apps gain a `build` script producing `dist/` | protocol-dev | `docker build` is attempted locally if Docker is available and the result is reported; otherwise reported as not run |
| 4.3 | ALB idle timeout 3600 s via `transform.loadBalancer.idleTimeout`; Fargate health checks on the health path; `warm: 1` on `dev`/`prod`, `0` on `pr-*`; Nextjs `nodejs22.x`, `arm64` | protocol-dev | Visible in source; cited in the PR against the spec scenario "Idle stream survives" |
| 4.4 | `.github/workflows/ci.yml` (lint, typecheck, test on PR and `main`) | qa | `actionlint` clean |
| 4.5 | `.github/workflows/preview.yml`: CI gate → OIDC role → create schema → `sst deploy --stage pr-<n>` → sticky PR comment with web URL and MCP URL; skipped unless `A2H_DEPLOY_ENABLED == 'true'`; same-repo PRs only | qa | `actionlint` clean; spec scenarios "PR opened", "PR updated", "Typecheck fails" mapped |
| 4.6 | `.github/workflows/teardown.yml`: on close → `sst remove --stage pr-<n>` → drop schema, login and secret (amendment 1) | qa | `actionlint` clean; scenario "PR closed" mapped |
| 4.7 | `.github/workflows/deploy.yml`: on push to `main` and `workflow_dispatch` → CI → `sst deploy --stage dev` | qa | `actionlint` clean; scenario "Merge to main" mapped |
| 4.8 | `.github/scripts/pr-schema.sh create|drop <n>` used by 4.5 and 4.6 | qa | `shellcheck` clean; identifier validated as an integer before use |
| 4.9 | `docs/runbooks/aws-bootstrap.md`: account, OIDC provider and role (least privilege for SST bootstrap + deploy), first `dev` deploy by `workflow_dispatch`, SES identity verification and production access, domain, Stripe test keys as SST secrets, GitHub variables, key rotation | pm | Reviewed by the owner at CHECKPOINT 3 |
| 4.10 | Cold review of the PR | reviewer | No blocking finding open |
| 4.11 | ESLint (typescript-eslint, flat config) with a `lint` script in every workspace package, so `pnpm lint` runs real tasks | qa | `pnpm lint` runs ≥ 1 task per package and is green; CI fails on a lint error |

CHECKPOINT 3: the owner reviews the stacks and the runbook, decides the open items listed in the PR, and runs the bootstrap.

**CHECKPOINT 3 passed on 2026-10-25.** The owner approved PR #6 as a whole. The "Decide first" items are therefore settled as proposed: ADR 0001 Amendment 1 accepted; branch protection gap accepted for now (private repository on a Free plan); no domain yet (needed by M1 Gate 2); network choice deferred to M1; upload retention 180 days; budget alert €80/month. The AWS account choice (dedicated vs shared) is being confirmed before runbook §3 runs.

## Step 5: hello world (issue #5)

Decisions and contract (PM, 2026-10-25; library facts from vendor docs because Context7 has no valid key):

- **MCP server on the v2 packages** `@modelcontextprotocol/server` 2.4.0 + `@modelcontextprotocol/node` 2.1.2 (stateless `createMcpHandler`, default legacy mode so 2025-era clients such as MCP Inspector still work). v2 is the stable line implementing the 2026-07-28 spec that CLAUDE.md requires; the v1 `@modelcontextprotocol/sdk` 1.32 stops at 2025-11-25. CLAUDE.md's package name is amended at Gate 2.
- **`ping` takes an optional `holdSeconds` (integer 0–3900)** and stays silent for that long before answering `pong from stage <STAGE>`. It exists so the scenario "Idle stream survives" can be proven without a test hook. SSE keep-alive comments are off for the same reason.
- **ALB idle timeout 4000 s** (AWS maximum) because the scenario is 61 minutes = 3660 s; Node `requestTimeout` 0, `keepAliveTimeout` 4010 s.
- **Worker:** pg-boss 12.38 in schema `DB_SCHEMA` with `createSchema: false` (a preview login has no CREATE on the database); TLS to Postgres verified with the RDS CA bundle baked into the image; one `heartbeat` job sent and processed at each start. Note for M1 (D1): on `dev`/`prod` pg-boss's tables live in `public`; the first Drizzle change must give pg-boss its own schema or avoid its table names.
- **Web:** Next.js 15.5 (SST 4.17.2 bundles OpenNext 3.9.14, which targets Next 15; Next 16 is a later infra change), one server-rendered page (`force-dynamic`) showing stage and MCP URL from the Lambda's env, system font, no palette.
- **Live tests** (`tests/contract`, `tests/e2e`, `tests/ci/preview-smoke.sh`) take `A2H_MCP_URL` / `A2H_WEB_URL` and run against a preview; not wired into CI yet (QA proposes a `preview-verify` job after the deploy; PM decides after Gate 2). The idle test is opt-in via `A2H_IDLE_MINUTES=61`.
- **Exemption, recorded:** the `ping` input shape (`holdSeconds`) lives in `apps/mcp`, not in `packages/protocol`, because the proposal puts every protocol shape out of M0's scope and `ping` is a transport diagnostic. The first real tool (M1) moves tool shapes to `packages/protocol`, which then needs a build step before it can be bundled into the images (Node does not type-strip `.ts` under `node_modules`).
- **Idle-stream proof:** previews borrow the `dev` load balancer, so the 4000 s idle timeout applies only after `main` redeploys `dev`. On a preview the hold is proven up to 59 minutes; the 61-minute run happens against `dev` `/mcp` after the merge and is recorded on the PR.
- **Held `ping` concurrency:** unauthenticated callers can hold connections for up to 65 minutes with no cap; recorded for the M1 auth proposal (cap concurrent holds, or allow `holdSeconds > 0` off `prod` only).
- **Spec wording to fix at archive:** the scenario "Initialize from a fresh client" says `initialize`; on 2026-07-28 the handshake is `server/discover`. The tests assert the modern handshake and report the legacy one informationally. Also "Idle stream survives" describes an already-open stream; with the v2 handler a held `ping` sends no bytes at all until the result, so the proven property is "an exchange with nothing sent either way for 61 minutes survives", which is what the load balancer timeout governs. Reword the scenario that way.

| # | Task | Owner | Acceptance |
|---|---|---|---|
| 5.1 | `apps/mcp`: `ping` tool over Streamable HTTP, stateless, health path, `MCP_BASE_PATH` honoured | protocol-dev | Scenarios "Initialize from a fresh client", "Tools are listed", "ping is called", "Load balancer probes health" each have a green test |
| 5.2 | `apps/worker`: one no-op pg-boss job in schema `DB_SCHEMA` | protocol-dev | A test shows the job registered and run once |
| 5.3 | `apps/web`: one page | web-dev | A test renders it |
| 5.4 | MCP contract test against the preview endpoint; "Idle stream survives" (61 min) as a manually triggered test; "Requests hit different instances" with two tasks | qa | Scenario → test table in the PR |
| 5.5 | PR with "how to validate" for the owner | pm | GATE 2 |
