# Runbook: shared MCP servers (`.mcp.json`)

`.mcp.json` at the repo root configures the MCP servers every A2H agent may use (CLAUDE.md §Shared MCP tools). It contains **no credentials**: every secret is read from an environment variable at launch. This runbook lists what you must set once, and why each server is scoped the way it is.

Set the variables in your shell profile (or a local secret manager that exports them), never in a file inside the repo. `.env*` is gitignored, but `.mcp.json` is committed, so it must stay placeholder-only.

## Prerequisites

| Tool | Needed by | Install |
|---|---|---|
| Node 22 + pnpm 10 | Playwright | `nvm use` in the repo, `corepack enable` |
| `uv` (gives `uvx`) | postgres-readonly, aws-cloudwatch, aws-api-readonly | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| AWS CLI v2 | the two AWS servers (credential profile) | already present on the dev box |

## Variables to set

| Variable | Server | What to put there | Scope / notes |
|---|---|---|---|
| `GITHUB_MCP_PAT` | github | A fine-grained or classic PAT for `xxl007/a2h` | Classic scopes: `repo`, `workflow`, `read:org`, `project` (board writes) or `read:project`. The `gh` CLI token on this box lacks `project`; run `gh auth refresh -s project,read:project` so the PM can create the board. Alternative: remove the `headers` block and let Claude Code do OAuth via `/mcp`. |
| `STRIPE_AGENT_API_KEY_TEST` | stripe | A Stripe **agent API key** created in a **sandbox / test mode** account, with only the permissions needed (PaymentIntents, Connect accounts, Identity sessions, read on balance and payouts) | Test mode until you say otherwise (CLAUDE.md). Stripe stops accepting plain secret keys for MCP after 30 Nov 2026; agent keys or OAuth only. OAuth alternative: drop the `headers` block and authenticate with `/mcp`. |
| `A2H_DATABASE_URI_READONLY` | postgres-readonly | `postgresql://a2h_ro:<pw>@<aurora-dev-endpoint>:5432/a2h` for a **read-only role** | Create the role after the Aurora dev cluster exists (ADR 0001, aws-bootstrap runbook). The server also runs in `--access-mode=restricted` (read-only transactions, bounded query time), so even a mis-scoped role cannot write through it. Point it at a preview schema with `?options=-csearch_path%3Dpr_<n>` when debugging a PR. |
| `CONTEXT7_API_KEY` | context7 | A free key from context7.com | Optional: a key only raises rate limits. If you have none, delete the `headers` block from the `context7` entry. |
| `A2H_AWS_PROFILE` | aws-cloudwatch, aws-api-readonly | Name of an AWS CLI profile; defaults to `a2h` | The profile must carry **read-only** IAM permissions (`ReadOnlyAccess` plus `logs:StartQuery`, `logs:GetQueryResults`, `logs:StopQuery` for CloudWatch Logs Insights). Long-lived keys are a bootstrap convenience only; CLAUDE.md requires IAM roles and no long-lived keys for services. Rotate them after bootstrap. |
| `A2H_PLAYWRIGHT_OUTPUT_DIR` | playwright | Where screenshots land; defaults to `/tmp/a2h-playwright-mcp` | Keep it outside the repo so screenshots are never committed. |
| `A2H_AWS_MCP_WORKDIR` | aws-api-readonly | Scratch dir for the AWS API server; defaults to `/tmp/a2h-aws-mcp` | Must be an absolute path. |

## Why these servers, and their guardrails

- **github** (remote `api.githubcopilot.com/mcp/`): issues, PRs, projects for tracking. The PM creates issues and moves board cards; devs link PRs. No repo secret is reachable through it.
- **playwright** (`@playwright/mcp`, headless, isolated profile): QA e2e on previews, Design review screenshots at 390px and 1280px. Isolated means no cookies survive a session.
- **stripe** (remote `mcp.stripe.com`, test mode): inspect PaymentIntents (manual-capture holds), Connect Express accounts, Identity sessions while building M4. Writes that Stripe considers risky (refunds, payouts) require a human confirmation link, which is the behaviour we want.
- **postgres-readonly** (`postgres-mcp` restricted mode): debugging the dev cluster and per-PR schemas. Read-only by role **and** by server mode. Business code never uses this path; it talks to Postgres through the connection string in `packages/db`.
- **context7** (remote): library docs. CLAUDE.md: use it before relying on memory for SST, Turborepo, the MCP SDK, Better Auth, Drizzle, Next.js.
- **aws-cloudwatch** (`awslabs.cloudwatch-mcp-server`): structured logs and metrics of the Fargate services and Aurora. Read-mostly by permission set; the profile's IAM policy is the real control.
- **aws-api-readonly** (`awslabs.aws-api-mcp-server`, `READ_OPERATIONS_ONLY=true`, mutation consent on): ECS service and task inspection, Aurora cluster status, ALB health. AWS marks this server as superseded by the hosted "AWS MCP" (`mcp-proxy-for-aws`); we keep the local one because its read-only switch is explicit. Revisit when the hosted server documents an equivalent.
- **Not included on purpose:** the Amazon ECS MCP server (it deploys; deploys go through SST in CI only), any Aurora *Data API* server (we do not enable the Data API), and the deprecated `@modelcontextprotocol/server-github` / `server-postgres` packages.

## Verify

```sh
# from the repo root, with the variables exported
claude mcp list            # every server should show as configured
# inside a Claude Code session:
/mcp                       # connect; complete OAuth for github/stripe if you removed the headers
```

Then ask the PM agent to call one read tool per server (list issues; take a screenshot of docs/prototypes/principal.html; retrieve the Stripe test account; `SELECT 1`; resolve the SST docs id; describe log groups; describe ECS clusters). Anything that fails is a variable or IAM issue, not a repo change.

## Rotation

Rotate `GITHUB_MCP_PAT`, `STRIPE_AGENT_API_KEY_TEST` and the AWS keys behind the `a2h` profile whenever they have been pasted into a chat, a ticket or a terminal shared with an agent. The repo never needs to change for a rotation.
