# A2H — Agent-to-Human

A protocol and platform that lets AI agents find consenting humans, send them questions on behalf of an accountable principal, and bring back attested answers.

Start here:

- [CLAUDE.md](CLAUDE.md) — how we work: roles, workflow, stack, engineering rules. Read first.
- [docs/PRD.md](docs/PRD.md) — product requirements, protocol, milestones and gates.
- [docs/prototypes/](docs/prototypes/) — click-through prototypes (principal and participant), the visual reference for M2–M5.
- [docs/decisions/](docs/decisions/) — architecture decision records.
- [docs/runbooks/](docs/runbooks/) — one-time setup and operations.

## Layout

pnpm + Turborepo monorepo, TypeScript everywhere, Node 22 (`.nvmrc`). See CLAUDE.md §Stack for what each folder owns.

```
apps/web  apps/mcp  apps/worker  infra/  packages/{protocol,db,ui,email}  tests/  openspec/  docs/  .claude/
```

## Getting started

```sh
nvm use            # Node 22
corepack enable    # pnpm 10, pinned in package.json
pnpm install
pnpm typecheck
```
