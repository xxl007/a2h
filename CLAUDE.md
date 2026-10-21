# A2H — Agent-to-Human protocol

This repository implements A2H: a protocol and platform that lets AI agents find consenting humans, send them questions on behalf of an accountable principal, and bring back attested answers. Read `docs/PRD.md` before doing anything. Product decisions live there; this file is about how we work.

## The one rule

**Nothing reaches a human that the human's rules do not allow, and nothing leaves a principal that the principal did not approve.** Every change is checked against this. The human's attention is the scarce resource; the agent's convenience never wins a tie.

## Roles

Work is done by a small team of agents. The user (product owner) watches every milestone and validates before the next one starts.

| Agent | Responsibility | Must follow |
|---|---|---|
| **PM** (main session) | Owns `docs/PRD.md`, `openspec/`, the roadmap and all communication with the product owner. Writes proposals, splits tasks, dispatches subagents, requests gates. Never writes production code. | superpowers `brainstorming`, `writing-plans`, `subagent-driven-development`, `dispatching-parallel-agents`; OpenSpec `propose` / `apply` / `archive` |
| **Design** | Owns `packages/ui` (tokens, components, Storybook), screen specs and copy in each change's `design.md`, accessibility. Reviews implemented UI on previews with Playwright screenshots. | `.claude/skills/a2h-design`, `requesting-code-review` |
| **Protocol dev** | Owns `packages/protocol`, `apps/mcp`, `apps/worker`, auction and settlement logic. | `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `using-git-worktrees`, `finishing-a-development-branch`, `.claude/skills/a2h-protocol` |
| **Web dev** | Owns `apps/web` (participant PWA, principal dashboard). | same as Protocol dev, plus `.claude/skills/a2h-design` |
| **QA** | Owns `tests/`, CI, the release checklist, adversarial cases. Writes failing tests for every spec scenario before marking a change verifiable. | `test-driven-development`, Playwright MCP, `.claude/skills/a2h-protocol` |
| **Reviewer** (ephemeral, cold) | Reviews each PR without having seen it being written. | `receiving-code-review` counterpart; blocks on: missing tests, spec drift, the one rule |

Agents are dispatched with `subagent_type` matching `.claude/agents/<role>.md`. A subagent gets only its own worktree, its role file, the change folder and the skills listed above.

## Workflow: one OpenSpec change at a time

1. **Propose.** PM runs `/opsx:propose <change>` → `openspec/changes/<change>/proposal.md` + spec deltas. The proposal states: problem, scope, out of scope, spec scenarios, risks, how the product owner will validate it.
2. **Gate 1 (product owner).** PM posts the proposal summary and waits. No design or code before approval.
3. **Design.** If UI is involved, Design writes `design.md`: screens as HTML specs, tokens used, copy, states (empty, loading, error, offline), accessibility notes.
4. **Plan.** PM writes `tasks.md` with superpowers `writing-plans`: small tasks, each with its test, owner and acceptance.
5. **Build.** Devs work in git worktrees (`superpowers:using-git-worktrees`), TDD, one PR per change, conventional commits. PRs link the change folder and the GitHub issue.
6. **Verify.** QA runs the scenario tests, e2e on the preview, adversarial cases. Reviewer reviews cold. CI must be green.
7. **Gate 2 (product owner).** PM posts: what shipped, preview link, issues closed, what was deliberately not done. Waits for validation.
8. **Archive.** `/opsx:archive` merges spec deltas into `openspec/specs/`. Specs are the living truth; the PRD is updated if intent changed.

Milestones (M0–M6) are listed in `docs/PRD.md` §10. A milestone ends only at a passed Gate 2.

## Tracking: GitHub only

- Issues: one per task, labelled `change:<name>`, `role:<agent>`, `milestone:M<n>`.
- Project board columns: Proposed · Approved · Design · In progress · In review · QA · Awaiting owner · Done.
- PRs: `feat|fix|chore(scope): summary`, body links `openspec/changes/<change>/` and the issue, includes a preview link and a "how to validate" section written for the product owner.
- ADRs in `docs/decisions/NNNN-title.md` for any choice that would be expensive to reverse (schema shape, pricing, vendor).

## Stack

pnpm + Turborepo monorepo, TypeScript everywhere, Node 22.

```
apps/web        Next.js (App Router). Participant PWA + principal dashboard. Server actions for forms.
apps/mcp        A2H MCP server. @modelcontextprotocol/sdk, Streamable HTTP, stateless (2026-07-28 spec).
apps/worker     pg-boss jobs: expiries, fan-out, payouts, email, transcription.
infra/          SST v3 stacks: web, mcp, worker, database, email, storage, previews.
packages/protocol  Zod schemas + JSON Schema export for profile, manifest, request types, answers, attestation, settlement. Pure, no I/O.
packages/db     Drizzle schema + migrations (Postgres).
packages/ui     Design tokens, components, Storybook.
packages/email  React Email templates (Resend).
tests/          Playwright e2e, MCP contract tests (MCP Inspector scripted), adversarial suite.
openspec/       specs/ (truth) and changes/ (in flight).
docs/           PRD.md, decisions/, runbooks/.
.claude/        agents/, skills/, settings.
```

- Auth: Better Auth. Magic link only for participants; LinkedIn and X as read-only OAuth imports, never as login requirements.
- Payments: Stripe. PaymentIntent manual capture for holds (authorise the bid, capture the cleared price), Connect Express for payouts, Identity for verification. Test mode until the owner says otherwise.
- Email: SES (React Email renders the templates). Transcription: one `Transcriber` interface; Amazon Transcribe first, Deepgram as fallback. Voice notes and attachments in S3 via presigned uploads with lifecycle rules.
- Hosting: AWS, single region (eu-west-3 Paris), defined in `infra/` with SST v3.
  - `apps/web` → Amplify Hosting (Next.js SSR) or OpenNext on CloudFront + Lambda; SST decides, ADR records it.
  - `apps/mcp` and `apps/worker` → ECS Fargate services behind one ALB (idle timeout ≥ 1 h for SSE). Not App Runner: its 120 s request limit breaks streams.
  - Postgres → Aurora Serverless v2.
  - Secrets Manager for secrets, CloudWatch for structured logs and metrics, IAM roles per service, no long-lived keys.
  - Previews: one SST stage per PR (`sst deploy --stage pr-<n>`) sharing the dev Aurora cluster with a schema per PR; torn down on merge.
  - Keep business logic provider-neutral: AWS SDKs only inside `apps/*/infra` and `infra/`, containers for mcp and worker, Postgres only via connection string. Changing cloud must be a deployment change, not a rewrite.

## Shared MCP tools

Configured in `.mcp.json`. GitHub (issues, PRs, projects), Playwright (QA, design review), Stripe test mode (payments dev), Postgres read-only (debugging), Context7 (library docs), AWS MCP servers (CloudWatch logs and ECS/Aurora inspection, read-only; deploys go through SST in CI, never from an agent's shell). Use Context7 before relying on memory for any library API.

## Engineering rules

- TDD. A test exists before the code it tests. Spec scenarios in `openspec/specs` map 1:1 to tests in `tests/` or package tests.
- `packages/protocol` is the single source of truth for every shape. The MCP tools, web forms, worker and tests import it. No duplicated schemas.
- Money is integers in minor units. All money moves happen in a Postgres transaction with an append-only `ledger_entries` table. Never update a balance in place.
- Every request carries an accountable principal (verified person or organisation). Every answer carries a signature, timestamp, confidence, and `answered_personally: true`.
- Rules-of-engagement enforcement happens at manifest validation, server side, before any delivery. A blocked manifest is logged and counted for the participant to see.
- Emails carry the summary only: asker, request type, offer, deadline, competition note. Never the question text.
- Identity verification is required for paid lanes but may lag until payout. The principal is told when an answer comes from a not-yet-verified participant.
- No agent assistance on the participant side. The answer form never calls a model.
- Accessibility: WCAG 2.2 AA, keyboard-complete, 44px targets on the PWA, reduced-motion respected.
- Logging: structured, no PII in logs, request ids everywhere. Secrets only in env, never in the repo.
- Definition of done for a change: spec scenarios tested, CI green, preview validated by the owner, specs archived, ADR written if applicable.

## Communication with the product owner

- Status at each gate, short: what, where to click, what to decide. Lead with the decision needed.
- Open questions go in the proposal, not in chat mid-build. If blocked by a decision that can't be undone, stop and ask.
- Never claim something is verified that was not run. Say what was tested and what was not.
- Attribution on commits as configured by the environment.
