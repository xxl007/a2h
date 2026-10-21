# Tasks: m0-foundation

Steps 1–3 are done and approved (issues #1–#3 closed, 2026-10-21). This file covers steps 4 and 5. Owner per task is the agent role; every task names its acceptance. Nothing in this change is deployed by an agent.

## Step 4: infrastructure as code and delivery pipeline (issue #4)

Contract between the two owners (fixed by the PM; change it only through the PM):

- SST app name `a2h`, `home: "aws"`, region `eu-west-3`, SST pinned to the current 4.x line (the Ion component API; see ADR 0001 amendment note in the PR).
- Stages: `dev` (long-lived, deployed from `main`), `pr-<n>` (ephemeral, one per pull request), `prod` (defined, never deployed in M0, `protect: true`).
- Shared resources are created by `dev` and reused by `pr-*` through the components' `static get`: VPC, ECS cluster, ALB, Aurora cluster, uploads bucket, SES identity. `dev` publishes their identifiers as SSM parameters under `/a2h/shared/`: `vpc-id`, `cluster-id`, `alb-arn`, `aurora-cluster-id`, `aurora-cluster-arn`, `aurora-secret-arn`, `uploads-bucket`, `email-sender`. `pr-*` stages read them at deploy time.
- Database `a2h` on the shared Aurora cluster. Schema per stage: `public` for `dev`, `pr_<n>` for `pr-<n>`. The schema is created before `sst deploy` and dropped before `sst remove` by the workflows through the RDS Data API (`aws rds-data execute-statement`), using the two Aurora ARNs above. Services receive `DB_SCHEMA` and connect with a search path limited to it.
- Routing on the shared ALB: `dev` MCP at `/mcp` (health `/healthz`), `pr-<n>` MCP at `/pr-<n>/mcp` (health `/pr-<n>/healthz`). Services receive `MCP_BASE_PATH`. Listener-rule priorities: `dev` 49000, `pr-<n>` = 100 + n.
- `sst deploy` outputs (`.sst/outputs.json`): `stage`, `web` (web URL), `mcp` (full MCP endpoint URL).
- GitHub repository **variables** (not secrets): `AWS_DEPLOY_ROLE_ARN`, `A2H_DEPLOY_ENABLED` (`true` only after the owner's bootstrap). No AWS key ever appears in GitHub secrets.
- GitHub repository **variables** (not secrets): `AWS_DEV_ROLE_ARN`, `AWS_PREVIEW_ROLE_ARN`, `A2H_DEPLOY_ENABLED` (`true` only after the owner's bootstrap). No AWS key ever appears in GitHub secrets.

### Contract amendment 1 (after the cold review of PR #6, 2026-10-21)

- **Two deploy roles, neither named `a2h-*`.** `gha-a2h-dev` is trusted only for `repo:xxl007/a2h:ref:refs/heads/main` (push to main and `workflow_dispatch` on main): `deploy.yml` uses it. `gha-a2h-preview` is trusted only for `repo:xxl007/a2h:pull_request`: `preview.yml` and `teardown.yml` use it. Policies in `infra/bootstrap/`.
- **Permissions boundary on every workload role.** The deploy roles may create or modify `role/a2h-*` only when the role carries the boundary `arn:aws:iam::<account>:policy/a2h-workload-boundary`, which denies all IAM and STS role assumption. `sst.config.ts` applies it to every `aws.iam.Role` through a global `$transform`. The boundary ARN is built from the caller's account ID, not hard-coded.
- **Per-PR database login.** `pr-schema.sh create <n>` creates or reuses the Secrets Manager secret `a2h/pr-<n>/db` (`{"username":"pr_<n>","password":…}`, random password, value masked in logs). It then creates or updates login role `pr_<n>`, creates schema `pr_<n>` with `AUTHORIZATION pr_<n>`, revokes `CREATE` and `USAGE` on schema `public` and `CONNECT` on database `a2h` from `PUBLIC`, grants `CONNECT` to `pr_<n>`, and sets the role's `search_path` to `pr_<n>`. The `pr-<n>` stage injects `DB_USER=pr_<n>` and `DB_PASSWORD` from that secret, and **never** the master credentials. `dev` keeps the master user for M0.
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
| 4.6 | `.github/workflows/teardown.yml`: on close → drop schema → `sst remove --stage pr-<n>` | qa | `actionlint` clean; scenario "PR closed" mapped |
| 4.7 | `.github/workflows/deploy.yml`: on push to `main` and `workflow_dispatch` → CI → `sst deploy --stage dev` | qa | `actionlint` clean; scenario "Merge to main" mapped |
| 4.8 | `.github/scripts/pr-schema.sh create|drop <n>` used by 4.5 and 4.6 | qa | `shellcheck` clean; identifier validated as an integer before use |
| 4.9 | `docs/runbooks/aws-bootstrap.md`: account, OIDC provider and role (least privilege for SST bootstrap + deploy), first `dev` deploy by `workflow_dispatch`, SES identity verification and production access, domain, Stripe test keys as SST secrets, GitHub variables, key rotation | pm | Reviewed by the owner at CHECKPOINT 3 |
| 4.10 | Cold review of the PR | reviewer | No blocking finding open |
| 4.11 | ESLint (typescript-eslint, flat config) with a `lint` script in every workspace package, so `pnpm lint` runs real tasks | qa | `pnpm lint` runs ≥ 1 task per package and is green; CI fails on a lint error |

CHECKPOINT 3: the owner reviews the stacks and the runbook, decides the open items listed in the PR, and runs the bootstrap.

## Step 5: hello world (issue #5)

| # | Task | Owner | Acceptance |
|---|---|---|---|
| 5.1 | `apps/mcp`: `ping` tool over Streamable HTTP, stateless, health path, `MCP_BASE_PATH` honoured | protocol-dev | Scenarios "Initialize from a fresh client", "Tools are listed", "ping is called", "Load balancer probes health" each have a green test |
| 5.2 | `apps/worker`: one no-op pg-boss job in schema `DB_SCHEMA` | protocol-dev | A test shows the job registered and run once |
| 5.3 | `apps/web`: one page | web-dev | A test renders it |
| 5.4 | MCP contract test against the preview endpoint; "Idle stream survives" (61 min) as a manually triggered test; "Requests hit different instances" with two tasks | qa | Scenario → test table in the PR |
| 5.5 | PR with "how to validate" for the owner | pm | GATE 2 |
