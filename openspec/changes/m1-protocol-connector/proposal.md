# Proposal: m1-protocol-connector

Milestone M1 (PRD §10), first of two changes. The second, `m1-hosted-connector` (domain and TLS, MCP authorization, rate limits, the held-`ping` cap, verification in a hosted web client), is proposed after this one passes Gate 2. Tracking: GitHub milestone "M1 Protocol and connector", labels `change:m1-protocol-connector`, `milestone:M1`.

## Why

M0 proved the transport: any MCP client can reach the A2H server over Streamable HTTP, statelessly, and hold a stream for an hour. Nothing on it yet speaks A2H. Every later milestone (participant onboarding, delivery, money, principal surface) needs the protocol shapes fixed and a connector an agent can actually use: discover a human, show the principal the exact question, get an approval, and later collect a signed answer. Doing this against simulated participants first lets the product owner validate the principal-side experience in Claude Code, end to end, before any real human or any euro is involved.

## What Changes

- **`packages/protocol` becomes complete** (CLAUDE.md: the single source of truth for every shape). Zod schemas and JSON Schema export for: profile and handle, rules of engagement, manifest (four axes: intent, audience, time shape, format), request and its closed status enum, per-intent answer bodies, the answer envelope (confidence, `answered_personally: true`, `signed_at`, `key_id`, `signature`), `ProtocolError`, ledger entry, and the inputs/outputs of the five tools. Pure functions: `canonicalAnswerPayload`, Ed25519 sign/verify over that payload (keys passed in), `gross`/`net`/`clear` with the share `s` and fee `f` as arguments (ADR 0002: no number is assumed), id and handle formatting (randomness passed in). No I/O.
- **`packages/db` gets its first Drizzle schema and migrations**: simulated participants and their published rules, requests, request events (one row per state transition), blocked manifests (codes only, no text), answers, platform signing keys. Migrations run in the deploy workflows per stage, before the services roll.
- **`apps/mcp` serves three A2H tools** next to `ping`: `find_humans`, `request_human`, `check_requests`. Tool descriptions carry the policy text (humans are a last resort; search first; show the question to the principal; the principal pays what clears, never more than the hold). `request_human` runs the manifest validation pipeline, then asks the principal for approval through form-mode elicitation with exactly one pre-filled string field (the question) and accept/decline; only an accept creates the request, byte-identical to the approved text. Returns `request_id`, `eta`, `status: "sent"`, `held_minor` in under a second.
- **`apps/worker` runs the request lifecycle**: delivery (re-validates the manifest at fan-out), expiry, and a participant simulator that plays scripted personas (fast accept and answer, decline with reason, slow answer, "can't tell", never responds so the request expires). Simulated answers are real signed envelopes using a platform-held development key, so `check_requests` returns exactly what a real answer will look like.
- **Money is represented, not moved.** Bids, reserves, gross/net figures and the hold amount are computed and shown; no Stripe object and no ledger row is created. Budget and per-request cap come from a fixed development contact policy. The `wallet` and `cancel_request` tools, Stripe and the ledger land in M4.
- **Tests**: a contract test per spec scenario (QA), schema fixture pairs and JSON Schema snapshots (protocol), a lifecycle table test, and the applicable adversarial cases from the protocol skill (push-poll, third-party personal data, labour disguised as a question, quiet hours, over-interruption, bid below reserve, unsigned answer, answer without attestation).
- **`packages/protocol` needs a build step** before the mcp and worker images can bundle it (M0 exemption: Node does not type-strip `.ts` under `node_modules`). `tsconfig.build.json` emits to `dist/`; the Dockerfiles copy it.

## Out of scope

- Authorization (OAuth per the MCP spec), rate limits, the cap on held `ping` connections: `m1-hosted-connector`.
- A domain, TLS, and verification in a hosted web client (claude.ai, ChatGPT): `m1-hosted-connector`; needs the owner's domain decision (runbook §8).
- Any participant-side surface: email, request page, answer form, onboarding (M2, M3). Simulated participants never receive anything.
- `cancel_request`, `wallet`, Stripe, ledger rows, payouts (M4). Campaigns, threaded rounds, referral forwarding, MCP Apps card, MCP Tasks, REST API and webhooks (M5, M6).
- Any change to `apps/web` (it keeps showing the stage and the MCP URL).

## Capabilities

### New Capabilities

- `protocol/schemas`: every A2H shape exists once, in `packages/protocol`, with a JSON Schema export and pure helpers; consumers derive, never duplicate.
- `protocol/discovery`: `find_humans` returns ranked handles with published terms and auditable ranking inputs, never identity or contact details.
- `protocol/request-approval`: `request_human` validates the manifest server side and delivers nothing until the principal has approved the exact wording through elicitation.
- `protocol/request-lifecycle`: the closed status set, its legal transitions, who may cause each, and what `check_requests` reports at each state.
- `protocol/answer-attestation`: an answer is accepted only as a signed envelope with confidence and a personal attestation; the signature covers the canonical payload and verifies after key rotation.
- `platform/participant-simulation`: on `dev` and preview stages a set of synthetic participants with scripted personas accepts, declines, answers or ignores requests, so the principal flow can be validated without a human.

### Modified Capabilities

- `platform/mcp-transport`: "Tools are listed" now expects `find_humans`, `request_human`, `check_requests` and `ping`, each with a description carrying the policy text, and input/output schemas exported from `packages/protocol`.

## Impact

- `packages/protocol` (new code, build step), `packages/db` (new schema, migrations, migration command), `apps/mcp` (three tools, Postgres connection, validation pipeline), `apps/worker` (three queues, simulator), `tests/contract` (new scenarios), `tests/adversarial` (new), `.github/workflows/{preview,deploy}.yml` and `.github/scripts/pr-schema.sh` (migration step, a second schema for pg-boss), `infra/` (the mcp service gets database credentials like the worker; a `SIGNING_KEY` secret per stage), `docs/runbooks/` (seeding the simulated participants, rotating the signing key).
- New dependencies: `drizzle-orm`, `drizzle-kit`, `pg`, `zod` JSON Schema export (Zod 4 has `z.toJSONSchema`), `@noble/ed25519` or Node's `crypto` (design decides).
- Decisions recorded in this change: pg-boss moves to its own schema (M0 note D1); `s` and `f` stay configuration values.

## Risks

- **Client support for the 2026-07-28 approval flow.** The server is stateless, so approval must ride the multi-round-trip `input_required` result of the 2026-07-28 revision (the SDK in the lockfile, `@modelcontextprotocol/server` 2.4.0, implements it; the 2025 push-style elicitation needs a session and does not work statelessly). Spike result (task 1, draft PR #24): the server side works; Claude Code 2.1.226 with default settings stays on 2025-11-25 and shows no dialog, and only with `MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto` does it negotiate 2026-07-28 and complete the round trip. The changelog claim of default 2026-07-28 negotiation did not hold for this account. Decision 5 below.
- **Simulated answers mistaken for real ones.** Every simulated participant's handle starts with `sim-`, its display label says "(simulated)", and `check_requests` carries `simulated: true` on such answers. The simulator never runs on `prod`.
- **Shape churn later.** Shapes are the hardest thing to change; they follow the protocol skill §3–§10 and ADR 0002 verbatim, and every OPEN item stays a parameter, never a number.
- **Preview database login rights.** A preview login owns one schema; migrations and pg-boss need a second one. `pr-schema.sh` creates both; the login owns both.

## How the product owner validates (Gate 2)

From a terminal, with Claude Code pointed at the preview's MCP endpoint (the exact `claude mcp add` command is in the PR):

1. Ask Claude Code to find a human for a topic the simulated participants cover ("find me someone who can judge whether a patient-information leaflet is alarming"). It calls `find_humans` and shows handles with terms and ranking inputs, no names.
2. Ask it to send a question to one of them. Claude Code shows the elicitation with the exact question pre-filled; edit the wording; accept. The result shows the request id, the ETA and the hold amount.
3. Decline one. Nothing is created; `check_requests` does not know the id.
4. Wait the persona's delay (under two minutes on previews), ask Claude Code to check. The answer renders with verdict, confidence, "answered personally", the signature and the timestamp, marked simulated.
5. Send a question whose bid is below the participant's reserve, or one that is a push-poll. Both are refused with a category, not a reason that reveals the participant's rules.

## Decisions needed at Gate 1

1. **Split of M1 into two changes** as described above (this change: protocol and connector on plain HTTP, validated in Claude Code; the next: hosted connector with domain, TLS, authorization). Alternative: one change, which delays any validation until the domain exists.
2. **Domain name** for `m1-hosted-connector` (runbook §8) so DNS and certificates can be requested in time; nothing in this change depends on it.
3. **Simulated participant set**: about twelve synthetic profiles across the request intents, in English, with obviously fictional labels. Confirm, or name the topics you want to see.
4. **Fallback if the spike fails** (see Risks): a session-ful server on one Fargate task per stage for M1 only, with the stateless flow restored when the client catches up. Alternative: wait for the client. Superseded by decision 5.

## Decision needed after the spike (issue #14, 2026-10-28)

5. **Approval path for M1.** (1) Build to 2026-07-28 and require `MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto` when launching Claude Code for M1; a 2025-era client gets a clear error telling it how to connect. Recommended: keeps the stateless design, no throwaway code. (2) The fallback of decision 4, deleted after M1. (3) Wait for the client flags. Only task 4.3 waits for this.
