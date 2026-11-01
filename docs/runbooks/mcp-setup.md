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

## Connecting hosted clients to a stage with sign-in (m1-hosted-connector, task 9.3)

Since m1-hosted-connector the MCP endpoint of every stage is an OAuth 2.1 resource server: a client without a token gets `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.dev.a2h-protocol.org/.well-known/oauth-protected-resource/<path>", scope="a2h"`, discovers the stage's authorization server (`https://<web host>/api/auth`, RFC 8414 metadata at `https://<web host>/.well-known/oauth-authorization-server/api/auth`), registers (Client ID Metadata Document when it has one, dynamic registration otherwise), sends the person to `https://<web host>/sign-in`, and exchanges the code for a one-hour token bound to that stage's MCP URL. Nothing is served on a token meant for another stage. Since the group 8.3 flip (PR #60) `PING_OPEN` is false on every stage: the handshake, the tool list and `ping` are challenged like the A2H tools, so a hosted client starts sign-in at once; only the health path and the protected-resource metadata stay open. (Until PR #60 is on the change branch, dev and previews still admit the tokenless handshake.)

Before any client can sign in, the address must be on the stage's allow-list (runbook `aws-bootstrap.md` §15; previews have their own parameter `/a2h/pr-<n>/principal-allowlist`, the line is in the preview comment), and on a non-production stage the magic link is read from the stage's mail sink (`tests/lib/mail-sink.ts`, or `aws s3 ls s3://<uploads bucket>/tmp/<stage>/mail/`), never from a mailbox.

### MCP Inspector (modern era, CIMD)

Inspector 2.x needs Node 22.19 or later (`nvm install 22`). Without a token the CLI is challenged (401) on every stage since PR #60; the line is still the quickest check that the endpoint answers:

```sh
npx -y @modelcontextprotocol/inspector@latest --cli https://mcp.dev.a2h-protocol.org/pr-<n>/mcp --method tools/list
```

With sign-in: `npx -y @modelcontextprotocol/inspector@latest`, transport Streamable HTTP, URL `https://mcp.dev.a2h-protocol.org/pr-<n>/mcp`, open **Authentication** and start the OAuth flow (or call `find_humans` and follow the 401). Inspector presents its own Client ID Metadata Document when the server advertises `client_id_metadata_document_supported` (it does), else it registers dynamically; the browser lands on the stage's sign-in page; read the link from the sink; consent names "MCP Inspector" and the two scopes; back in Inspector the four tools list and `find_humans` answers.

### Claude Code

```sh
claude mcp add --transport http a2h-pr<n> https://mcp.dev.a2h-protocol.org/pr-<n>/mcp
claude          # then, in the session:
/mcp            # select a2h-pr<n>, "Authenticate"
```

Claude Code opens the stage's sign-in page in the browser with a loopback redirect (the consent screen shows "a program on this computer"); after the magic link and **Connect**, `/mcp` shows the server connected and `find_humans`, `request_human`, `check_requests`, `ping` are available. Claude Code negotiates the 2025 revision by default; the approval form needs `MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude` (M1 note), which does not change the sign-in.

### claude.ai

Settings → Connectors → Add custom connector, URL `https://mcp.dev.a2h-protocol.org/mcp` (dev) or the preview's URL, authentication "Sign in now". claude.ai uses CIMD when advertised, else dynamic registration; its callback is `https://claude.ai/api/mcp/auth_callback`. Owner's step (Gate 2).

### Hosted-client matrix (task 9.3)

Recorded against the preview of PR #59 (stage `pr-59`, `https://mcp.dev.a2h-protocol.org/pr-59/mcp`, authorization server `https://pr-59.dev.a2h-protocol.org/api/auth`). "Registration path" is what the authorization server saw (`client_id` a URL = metadata document; a 32-character id = dynamic registration). A sign-in row needs an address on the preview's own allow-list (`/a2h/pr-59/principal-allowlist`) outside the verify job's window: the verify job admits the two QA addresses only for its own run and removes them, and QA makes no SSM write by hand, so the owner (or the PM) adds an address with the line in the preview comment before the row is run, and sets the value back to `none` afterwards.

| Client | Version | Registration path | Result | Date / notes |
|---|---|---|---|---|
| MCP Inspector CLI (tokenless) | 2.13.0 (Node 22.23.4) | none | Before PR #60 (`PING_OPEN=true` on previews): `tools/list` on pr-59 listed `ping`, `find_humans`, `request_human`, `check_requests`. After PR #60 the same command answers 401 with the challenge (the expected state; the live scenario "Handshake without a token" proves it). `/.well-known/oauth-protected-resource/pr-59/mcp` names the preview's own issuer; the issuer's RFC 8414 document answers 200 | 2026-11-01, commit 2a9c629 (pre-flip) |
| The contract client (`tests/lib/obtain-token.ts`, the verify job) | @modelcontextprotocol/client 2.4.0, jose 6 | metadata document (`https://pr-59.dev.a2h-protocol.org/test-fixtures/cimd/match.json`, the preview's own) | the row the verify job proves on every push: sign-in through the sink, consent, code, token bound to the preview's MCP URL, the four tools over the official client (step "Sign in through the mail sink and obtain tokens", then "MCP contract tests") | see the Verification line of the preview comment |
| MCP Inspector (sign-in) | 2.13.0 | pending | **Pending**: needs an allow-listed address on pr-59 outside the verify window (above). Procedure: `npx -y @modelcontextprotocol/inspector@2.13.0`, Streamable HTTP, the preview URL, **Authentication → Quick OAuth flow**; sign in with the address; read the link from the sink (`tests/lib/mail-sink.ts` with read access to the uploads bucket); consent; the four tools list | pending |
| Claude Code (`claude mcp add --transport http`, `/mcp`) | 2.1.226 | pending | **Pending**: same allow-list need, plus an interactive terminal for `/mcp` → Authenticate (no non-interactive path in 2.1.226; `--client-id` and `--callback-port` exist, the consent still opens a browser) | pending |
| claude.ai | - | - | owner's row (Gate 2) | owner, pending |
