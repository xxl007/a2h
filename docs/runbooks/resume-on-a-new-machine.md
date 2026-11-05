# Runbook: resume A2H work on a new machine

For the product owner or a fresh PM session after cloning `xxl007/a2h` on a machine that has never seen the project. Everything the team needs to continue is in the repository or in GitHub; nothing on the old machine is required. Where a step needs a credential, this runbook says where it is kept, never what it is.

## 1. What lives where

| Thing | Where | Notes |
|---|---|---|
| Code, specs, decisions, tasks | this repository | `openspec/specs/` is the truth; `openspec/changes/<change>/tasks.md` is the live checklist of the change in flight |
| Which change is in flight and its branch | `openspec/changes/` (non-archived folder) and the open PRs on GitHub | the change branch is `feat/<change>`; task PRs merge into it, the change PR merges into `main` |
| Work tracking | GitHub issues, PRs, project board | labels `change:<name>`, `role:<agent>`, `milestone:M<n>` |
| Owner decisions and their reasons | `docs/decisions/` (ADRs), `docs/PRD.md`, and the "Decisions" or "Spike result" sections of each change's `tasks.md` | |
| Deployed stages and secrets | AWS account 442123849268, eu-west-3, deployed only through SST in GitHub Actions | secrets in Secrets Manager and SSM; see `aws-bootstrap.md` §14–15 |
| MCP servers shared by the agents | `.mcp.json`; the credentials they need are described in `mcp-setup.md` | credentials come from the owner, never from the repo |
| Agent roles and skills | `.claude/agents/`, `.claude/skills/`, `CLAUDE.md` | registered when a Claude Code session starts in the repo root |
| Per-machine Claude Code memory | `~/.claude/projects/<path>/memory/` on the old machine | **not** carried over; everything it recorded that matters is in the files above. Rebuild it from `tasks.md` and the ADRs |

## 2. Install the toolchain (15 minutes)

```sh
# Node 22 through nvm; the repo pins the version in .nvmrc and pnpm in package.json
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22 && nvm use
corepack enable            # pnpm 10, version pinned in package.json

# GitHub CLI, signed in as the repo owner; the project board needs the project scope
gh auth login
gh auth refresh -s project,read:project

# AWS CLI v2 (read-only inspection only; deploys run in CI)
# profile chain, see aws-bootstrap.md §0: `a2h` = the management account user,
# `a2h-member` assumes OrganizationAccountAccessRole into the A2H account 442123849268.
aws configure --profile a2h
aws configure set role_arn arn:aws:iam::442123849268:role/OrganizationAccountAccessRole --profile a2h-member
aws configure set source_profile a2h --profile a2h-member
aws configure set region eu-west-3 --profile a2h-member

# Docker (unit tests of packages/db and apps/web start a throwaway Postgres 17)
# uv, for the Python MCP servers in .mcp.json
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Claude Code plugins used by the team: `superpowers` (marketplace `superpowers-marketplace`) and the OpenSpec commands (`npx -y @fission-ai/openspec@latest`, invoked as `/opsx:*`). Install them before the first PM session; the role files in `.claude/agents/` assume they exist.

## 3. Clone and check the tree (5 minutes)

```sh
git clone git@github.com:xxl007/a2h.git && cd a2h
nvm use && pnpm install
pnpm typecheck && pnpm lint && pnpm test      # tests start Docker Postgres containers; remove with `docker rm -v`
```

Then set the MCP variables from `mcp-setup.md` §"Variables to set" in the shell that starts Claude Code, and run `/mcp` inside the session to confirm the seven servers connect.

## 4. Find where work stopped (5 minutes)

1. `ls openspec/changes/` — the folder that is not under `archive/` is the change in flight. Read its `proposal.md`, then `tasks.md`: ticked tasks are merged into the change branch, with PR numbers and run ids as evidence; unticked tasks are the work left.
2. `gh pr list` — open PRs into the change branch are tasks in review or verification. A draft marked "spike, do not merge" is a throwaway preview and is never merged.
3. `git fetch --all && git branch -r` — every agent branch is pushed; a branch with no open PR and no mention in `tasks.md` is finished or abandoned, and `tasks.md` says which.
4. Open questions for the owner are listed at the end of the latest status in the change PR's comments and in the `tasks.md` "Owner" lines.

Start the PM session in the repo root with `claude`; it reads `CLAUDE.md` and the role files. Tell it the change name and that this is a fresh machine so it does not rely on the previous machine's memory.

## 5. Before shutting the old machine down

Run this sweep in the old clone and act on anything it prints:

```sh
git fetch --all --prune
git stash list                                  # must be empty
git worktree list                               # every worktree's branch must be pushed
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
  git rev-parse -q --verify origin/$b >/dev/null || echo "$b: not on remote"
  [ "$(git rev-list --count origin/$b..$b 2>/dev/null)" = 0 ] || echo "$b: ahead of remote"
done
for w in $(git worktree list --porcelain | awk '/^worktree/{print $2}'); do
  git -C $w status --porcelain | grep -qv '^??' && echo "$w: uncommitted changes"
done
```

Anything else on the machine (Playwright screenshots, scratch scripts, the per-machine memory directory) is disposable. Running agents die with the machine; their branches and PRs do not, and a new PM session redispatches from `tasks.md`.
