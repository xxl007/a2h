# Proposal: m0-foundation

Milestone M0 (PRD §10). Tracking: GitHub milestone "M0 Foundation", issues #1–#5, labels `change:m0-foundation`, `milestone:M0`.

## Why

Nothing can be built, reviewed or validated on a preview until the monorepo, the methodology, the cloud baseline and the delivery pipeline exist. M0 creates the smallest working path from a PR to a preview URL and a reachable MCP endpoint, so that every later change (M1–M6) can be validated by the product owner the same way.

## What Changes

- Monorepo skeleton: pnpm + Turborepo, Node 22, TypeScript, empty workspaces per CLAUDE.md §Stack. No business code.
- Methodology: superpowers plugin, OpenSpec initialised, `.claude/agents/{pm,design,protocol-dev,web-dev,qa,reviewer}.md`, skills `a2h-protocol` and `a2h-design`, `.mcp.json` with placeholder credentials and a setup runbook.
- Decisions: ADR 0001 (stack and hosting, Amplify vs OpenNext for `apps/web`), ADR 0002 (money model: hold = bid, provisional clearing rule, fee side, append-only ledger, minor-unit integers; percentage and fee left open for an ADR before M4).
- Infrastructure as code: SST v3 stacks in `infra/` for eu-west-3 (VPC, ALB with ≥1h idle timeout, ECS Fargate for `mcp` and `worker`, Aurora Serverless v2 dev cluster, SES identity, S3 with lifecycle, Secrets Manager, IAM roles per service), per-PR preview stages sharing the dev cluster with one Postgres schema per PR. GitHub Actions: CI (lint, typecheck, test), preview deploy on PR, teardown on close, deploy on main. A bootstrap runbook lists the one-time manual steps (account, OIDC role, SES production access, domain, Stripe keys).
- Hello world: `apps/web` renders one page, `apps/mcp` serves one `ping` tool over Streamable HTTP, `apps/worker` runs one no-op pg-boss job, each with a test, each provider-neutral.

## Out of scope

- Any protocol shape, tool other than `ping`, auth, email sending, payments, UI beyond one page (all M1+).
- Deploying anything from an agent shell. Deploys run in CI through SST after the owner's bootstrap.
- Production SES access, custom domain DNS, Stripe live mode.

## Capabilities

### New Capabilities

- `platform/mcp-transport`: the A2H MCP server is reachable over Streamable HTTP, stateless, and answers a `ping` tool call; the contract every later tool rides on.
- `platform/preview-environments`: every PR gets an isolated preview stage (web URL, MCP endpoint, Postgres schema) created on open and destroyed on close; `main` deploys to the dev stage.

### Modified Capabilities

None (first change).

## Risks

- Hosting choice for `apps/web` is expensive to reverse: settled in ADR 0001 before any infra code.
- ALB idle timeout and Fargate health checks for long-lived SSE streams: validated by the MCP contract test on the preview, not assumed.
- Shared dev Aurora cluster with a schema per PR: a teardown that misses a schema leaks data between PRs; the teardown workflow drops the schema explicitly and QA checks it.
- Long-lived AWS keys exist only on the owner's machine for bootstrap; CI uses an OIDC role.

## How the product owner validates (Gate 2)

1. Open the hello-world PR; CI is green.
2. Click the preview URL: the web page renders.
3. Call the MCP endpoint with MCP Inspector (command in the PR's "how to validate"): `ping` returns.
4. Confirm the worker ran its no-op job once in the preview logs (link in the PR).
5. Close a scratch PR and confirm its stage and schema are gone.
