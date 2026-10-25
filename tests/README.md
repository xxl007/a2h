# tests

QA-owned suites for A2H. Every scenario in `openspec/specs` (and in the deltas of the change in flight) maps to a test listed below; a scenario without a test blocks its change.

| Folder | What | Runs |
|---|---|---|
| `ci/` | Tests of the CI scripts and workflows (stubbed `aws`, real Postgres 17 in Docker, parsed YAML, bootstrap JSON) and the preview smoke script | `ci.yml`, "Check CI scripts" |
| `contract/` | MCP contract tests against a live MCP endpoint (`@modelcontextprotocol/client`, `node:test`) | by hand against a preview or `dev`; not in CI yet (needs a live URL) |
| `e2e/` | Playwright e2e of the web app against a live web URL, Chromium only, headless | by hand against a preview or `dev`; not in CI yet |
| `src/live-env.ts` | Reads the target URLs from the environment, derives the stage and the health URL | imported by `contract/` and `e2e/` |

## Running the live suites

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

"Live, manual" means it runs against a deployed stage and is started by hand (owner, PM or QA) until the `preview-verify` job exists. "CI" means it runs on every PR in `ci.yml`.

### platform/mcp-transport (6 scenarios)

| Scenario | Test | How it runs | Not automatable yet |
|---|---|---|---|
| Initialize from a fresh client | `contract/mcp-transport.test.ts` "Scenario: Initialize from a fresh client" (pinned `2026-07-28` connect: era modern, negotiated version, capabilities with `tools`, no session) | Live, manual | The spec says `initialize`; on `2026-07-28` the handshake is `server/discover`. The test follows the revision; the spec wording should follow too. |
| Tools are listed | `contract/mcp-transport.test.ts` "Scenario: Tools are listed" (`ping`, non-empty description, object input schema, optional integer `holdSeconds` 0..3900) | Live, manual | - |
| ping is called | `contract/mcp-transport.test.ts` "Scenario: ping is called" (no `arguments` member; text starts with `pong`, names the stage, not `isError`) | Live, manual | - |
| Requests hit different instances | `contract/mcp-transport.test.ts`, two tests: five fresh clients in a row (connect + call, no session header anywhere); a brand-new client whose first request is `tools/call` | Live, manual | A preview runs one MCP task (`McpPr<n>` 1-1), so two instances are never observed there. The tests prove the server needs no prior state; a true two-instance run needs `dev` scaled to 2 tasks, with the instance seen per response (not exposed today). |
| Load balancer probes health | `contract/mcp-transport.test.ts` "Scenario: Load balancer probes health" (200 within 1 s, no `Mcp-Session-Id`); `ci/preview-smoke.sh` (preview and dev health); `apps/mcp/test/health.test.ts` (unit, owned by Protocol-dev) | Live, manual; unit in CI | "No MCP state is created" is checked only as "no session header"; server memory is not observable from outside. |
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
