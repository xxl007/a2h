---
name: a2h-protocol
description: Load before touching anything that carries a request, an answer or money in A2H (packages/protocol, apps/mcp, apps/worker, request pages, answer forms, ledger, tests of any of these); it fixes the shapes, states, money rules and attestation every Protocol-dev, Web-dev and QA agent must follow.
---

# A2H protocol skill

Sources of truth, in order: `openspec/specs/` (archived scenarios), `docs/PRD.md`, `CLAUDE.md`, `docs/decisions/`. This skill distils them; it does not override them. Where a point is marked **OPEN**, do not decide it in code: stop, and raise it in the proposal.

## 1. The one rule and the six principles

**The one rule (CLAUDE.md):** Nothing reaches a human that the human's rules do not allow, and nothing leaves a principal that the principal did not approve. The human's attention is the scarce resource; the agent's convenience never wins a tie.

| Principle (PRD §3) | Engineering consequence |
|---|---|
| 1. Nothing reaches a human their rules don't allow; nothing leaves a principal they didn't approve. | Manifest validation runs server side, before any delivery (§6 below). `request_human` delivers nothing until an elicitation **accept** is recorded; the question delivered is byte-identical to the approved text. No "auto-send" path exists outside the principal's own contact policy (§6.2 PRD). |
| 2. Discover profiles, not people. Names are revealed only after acceptance. | `find_humans` returns handles (`mv-7f3c`) and published terms only: expertise + evidence, rating summary, latency, reserve, free lanes. Never email, phone, URLs, social handles or a real name. Identity is revealed to the other side only on the `accepted` transition. |
| 3. Asymmetric cost: asking costs the agent; answering or ignoring is nearly free for the human. | A send needs a funded wallet, a hold, budget headroom and a rate-limit slot. Decline is one tap from email, optional reason. Decline, expiry and "can't tell" never lower a participant's rating. |
| 4. Every request has an accountable principal. Every answer is signed, timestamped, carries confidence and was given personally. | The manifest schema requires a verified principal identity; the answer schema requires `signature`, `signed_at`, `confidence`, `answered_personally: true`. The server rejects anything else (§10). |
| 5. Asynchronous by design. No client needs to be woken. | `request_human` returns id + ETA in under a second and the session may end. Expiries, fan-out, emails and payouts are worker jobs. Email + `check_requests` closes the loop; MCP Tasks only for waits under ten minutes. |
| 6. Humans are a last resort: search first, then ask. | Tool descriptions carry the policy (§8). The agent must state what it tried, why no tool can answer and what kind of person can, before discovery. Discovery is silent on the human side; only a manifest reaches anyone. |

### Protocol trace (from the prototypes)

The two prototypes show the same request, `A2H-7f3c`, from both sides. Every change must be placeable on this trace.

| Principal phase | Participant phase | Tool / surface | Request state | Ledger kind |
|---|---|---|---|---|
| Discover | (Invite, Publish happened earlier) | `find_humans` | none | none |
| Manifest | — | `request_human` builds the manifest; validation §5 | none | none |
| Consent | — | form-mode elicitation, accept/decline | none → `sent` on accept | — |
| Escrow | — | PaymentIntent manual capture on the wallet | `sent` | `hold` |
| Elicit | Manifest (summary email, request page) | worker delivery job, email | `sent` | — |
| — | Consent (accept / decline) | request page, email decline button | `accepted` / `declined` | — / `release` |
| — | Verify (paid lane, once; may lag to payout) | Stripe Identity + Connect in Stripe's pages | `accepted` | — |
| Respond | Respond (signed answer) | answer form, signing service | `answered` | `capture`, `release`, `fee` |
| Settle | Settle (payout + ratings) | notification email, `check_requests`, Friday payout job | `answered` | `payout`, later `refund` on dispute |

Example calls as shown in the prototypes (display form; the protocol uses minor units): `find_humans {topic:"diabetes patient education", attested:true, latency:"≤24h", max_price:40}` → 3 handles; `request_human {to:"mv-7f3c", bid:30, expires:"2026-10-21T16:42+02:00"}` → `A2H-7f3c` in flight; `check_requests {id:"A2H-7f3c"}` → answered.

## 2. Vocabulary

- **Principal**: the person or organisation running the agent; accountable for every request; owns the wallet (PRD §2).
- **Participant**: the human who publishes a profile and answers; expert or sensor (PRD §2).
- **Profile / handle**: what `find_humans` returns; a handle like `mv-7f3c`, published terms, no identity (PRD §6.3).
- **Manifest**: the approved, validated request as it will be delivered: question verbatim, intent, audience, format, bid, expiry, data terms, principal identity (prototype phase "Manifest").
- **Request**: one manifest addressed to one participant, with an id `A2H-7f3c` and a lifecycle (§7).
- **Round**: one priced exchange inside a threaded request; follow-ups are new rounds (PRD §5, §7.7).
- **Campaign**: N deliveries of one manifest to a panel/sample/population, approved once (PRD §4, §6.2).
- **Lane**: `paid` (reserve + bid), `free` (participant-declared, €0, no hold), `bounty` (fixed price, first N) (PRD §8).
- **Reserve**: the participant's published minimum per request type (PRD §8).
- **Bid**: the principal's offer; sendable only if bid ≥ reserve (PRD §8).
- **Hold**: the amount authorised on the principal's wallet at send; hold = bid (PRD §8).
- **Clearing price**: what is actually captured, between reserve and bid, by the published rule (PRD §8).
- **Fee**: the platform's percentage of the clearing price, taken from the participant side (PRD §8).
- **Ledger entry**: one append-only row in `ledger_entries`; balances are derived from them (CLAUDE.md, PRD §8).
- **Attestation**: the participant's signed statement "I answered this myself" plus timestamp and confidence (PRD §7.6).
- **Signature**: Ed25519 signature over the canonical answer, key per participant, platform-held with rotation (PRD §11).

## 3. `packages/protocol` is the single source of truth

- Every shape (profile, rules of engagement, manifest, request, round, answer per intent, attestation, ledger entry, settlement, tool inputs/outputs, error) is a Zod schema in `packages/protocol`, with a JSON Schema export used for MCP tool `inputSchema`/`outputSchema`, REST and webhooks.
- Pure, no I/O: no database, network, clock or random inside the package. Ids, timestamps and keys are passed in.
- Every consumer imports from it: `apps/mcp`, `apps/web` (server actions and forms), `apps/worker`, `packages/db` types, `packages/email` props, `tests/`. No duplicated or hand-written shapes anywhere else. If a consumer needs a variant, derive it (`.pick`, `.extend`, `.omit`) in the package.
- Naming: schemas `PascalCase` + `Schema` (`ManifestSchema`, `AnswerJudgmentSchema`), inferred types `PascalCase` (`Manifest`), fields `snake_case`.
- Request ids: `A2H-` + 4 lower-case hex as shown in the prototypes (`A2H-7f3c`); the exact length/entropy for production is **OPEN (ADR 0002)** but the prefix and style are fixed. Handles: short slug + 4 hex (`mv-7f3c`). Signatures are displayed as `a2h:sig:…c91e`.
- Money: integers in minor units, field suffixed `_minor`, always paired with a 3-letter ISO currency: `bid_minor: 3000, currency: "EUR"`. No floats, no `amount` without `_minor`.
- Timestamps: ISO 8601 with offset (`2026-10-21T16:42:00+02:00`). Durations in seconds as integers.
- Enums are string literals, never numbers. Status enums are closed; adding a state is a spec change.

## 4. Request taxonomy: four axes (PRD §5)

Axes are independent: **intent** (fixes the answer schema and the rating criterion), **audience** (`named_individual` · `role_qualified_first_to_accept` · `panel_sample` · `population_in_place`), **time shape** (`one_shot` · `threaded` priced per round · `recurring`), **format** (`single_field` · `poll` · `form` · `upload` · `voice`).

Every answer, whatever the intent, also carries the common envelope of §10 (`confidence`, `answered_personally`, `signed_at`, `signature`). The shapes below are the intent-specific `body`.

| Intent | Default answer `body` (Zod-like) | Rated on |
|---|---|---|
| `observation` | `{ value: string; observed_at: datetime; place: string }` | correctness |
| `verification` | `{ verdict: 'confirm' \| 'deny' \| 'cant_tell'; evidence?: Attachment[] \| string }` | correctness |
| `judgment` (review) | `{ verdict: 'yes' \| 'no' \| 'cant_tell'; note?: { text?: string; voice?: VoiceNote } }` + envelope confidence | usefulness |
| `opinion` (preference) | `{ choice: option_id } \| { scale: number /* within declared min..max */ }` | completion |
| `estimate` (forecast) | `{ estimate: number; range: { low: number; high: number }; unit?: string }` + envelope confidence | calibration |
| `knowledge` (explanation) | `{ text?: string; voice?: VoiceNote }` (at least one) | usefulness |
| `authorisation` (decision) | `{ decision: 'approve' \| 'reject' \| 'edit'; edit?: string }`, signed by a real-name verified identity | validity |
| `action` | `{ artifacts: Attachment[] }` + attestation (envelope) | completeness |
| `referral` (introduction) | `{ forwarded_to: Handle[] \| 'none'; note?: string }`; **never** a contact | outcome |

Rules:
- `cant_tell` is first-class on every verdict-bearing intent and never penalised (PRD §7.6).
- `VoiceNote = { audio_ref: string; transcript: string; transcript_edited: boolean }`; the principal receives both (PRD §7.6). Audio retention after transcription is **OPEN (PRD §13.3)**.
- **Forbidden content classes**, rejected at manifest validation (PRD §5): `persuasion_disguised` (push-polling, framing tests on real people), `third_party_personal_data`, `labour_disguised`. Detection method is a spec/ADR matter; the classes and the rejection point are fixed.
- **Authorisation intent**: requires real-name verified identity on both sides. The minimum verification on the principal side is **OPEN (PRD §13.4)**; until decided, `authorisation` manifests from principals whose identity mode is not real-name-verified are rejected.
- **Referral**: the request is forwarded to the referred participant as a new manifest through the same validation pipeline; the referrer earns `referral_credit` (PRD §7.1). No name, email or handle-to-identity mapping is handed to the principal.

## 5. Manifest validation pipeline (server side, before any delivery)

Runs in `apps/mcp` for `request_human` and again in `apps/worker` at fan-out time (rules can change between approval and delivery). Ordered; stop at the first failure.

1. **Schema valid**: `ManifestSchema.safeParse`; question non-empty, within length, attachments within limits.
2. **Principal accountable and verified for the lane**: verified person or organisation; identity mode set in contact policy; for `authorisation` see §4.
3. **Forbidden classes** (§4).
4. **Participant rules of engagement** (PRD §7.3), evaluated against the participant's current published rules:
   - request type accepted (per-type on/off),
   - `bid_minor >= reserve_minor` for that type (hold = bid, so this also bounds the hold),
   - free lane: the manifest matches a declared free lane (own publications, facts about oneself) or it is paid,
   - who may ask: anyone verified / organisations only,
   - quiet hours: delivery time falls outside them (defer, do not drop, when the expiry allows; otherwise reject),
   - interruptions per day not exceeded (count deliveries, including deferred ones scheduled today),
   - latency: participant's promised latency fits inside the manifest expiry.
5. **Principal budget and per-request cap**: monthly budget headroom ≥ bid; bid ≤ per-request cap; autonomy rule (ask-first thresholds) satisfied by a recorded approval (PRD §6.2).
6. **Rate limits / throttling**: per principal per day; a principal with low internal rating is throttled before blocked (PRD §9).

Outcomes:
- Pass → request row created, hold placed (§9), delivery job enqueued.
- Fail → `blocked_manifests` row with `request_id`, `participant_id`, `principal_id`, `stage`, `code`, `at`. **No question text, no PII.** The participant sees the count and the category ("1 out of scope blocked"); the principal gets a reason **category**, never the participant's rules in detail (not the reserve, quiet hours or daily count).

Error taxonomy (shape to fix in the M3 spec; names are the proposal):

```ts
ProtocolError = {
  code: 'schema_invalid' | 'principal_not_accountable' | 'principal_not_verified_for_lane'
      | 'forbidden_content' | 'outside_participant_rules' | 'over_budget' | 'over_cap'
      | 'approval_required' | 'rate_limited' | 'not_found' | 'invalid_transition' | 'conflict';
  stage: 'schema' | 'principal' | 'content' | 'rules' | 'budget' | 'throttle' | 'lifecycle';
  retryable: boolean;            // rate_limited, quiet-hours deferral → true
  request_id?: string;           // never the question, never participant data
  detail?: string;               // for the principal: category text only
}
```

Participant-facing detail codes (`type_not_accepted`, `bid_below_reserve`, `free_lane_mismatch`, `asker_not_allowed`, `quiet_hours`, `interruption_budget`, `latency_mismatch`) live only in `blocked_manifests` and the participant's home, never in a tool result.

## 6. Request lifecycle (PRD §6.5, §8)

```
sent ──► accepted ──► answered
 │           │
 │           ├──► expired     (worker, at expiry)        hold released, nothing charged
 │           └──► cancelled   (principal)                cancellation fee to participant from the hold
 ├──► declined   (participant, from email or page)       hold released, nothing charged
 ├──► expired    (worker, at expiry)                     hold released, nothing charged
 └──► cancelled  (principal, before acceptance)          hold released, nothing charged
```

| Transition | Actor | Hold / money |
|---|---|---|
| create → `sent` | principal via `request_human` + elicitation accept | hold = bid authorised (free lane: no hold) |
| `sent` → `accepted` | participant | hold locked; identity revealed both ways; timer visible to principal |
| `accepted` → `answered` | participant (signed answer) | clear, capture clearing price, release the rest, fee entry |
| `sent` → `declined` | participant | release, nothing charged |
| `sent`/`accepted` → `expired` | worker | release, nothing charged |
| `sent` → `cancelled` | principal via `cancel_request` | release, nothing charged |
| `accepted` → `cancelled` | principal via `cancel_request` | cancellation fee from the hold to participant, rest released; fee amount **OPEN (ADR 0002)** |

- Terminal states: `answered`, `declined`, `expired`, `cancelled`. No transition out of a terminal state; `invalid_transition` otherwise. `accepted → declined` is not in the PRD: do not implement without a spec scenario.
- Transitions are idempotent by `(request_id, target_state)`; the ledger move and the state change happen in the same Postgres transaction.
- **Campaign**: one manifest, N deliveries, one approval, one budget check for N × bid; each delivery is its own request row with its own lifecycle and hold. Bounties pay the first N accepted answers; later answers are `expired` with release.
- **Threaded**: each round is a new priced request referencing `parent_request_id`; follow-ups are announced in the first manifest, priced, and declinable by the participant (PRD §7.7).
- **Role-qualified, first to accept**: deliver to the top-ranked participant first ("you first; if you decline, N others"); on decline/expiry the worker fans out to the next. Only the accepting participant's request proceeds; the others end `expired` with release.

## 7. MCP surface (PRD §6.1, §6.4, §6.5; CLAUDE.md Stack)

Tools: `find_humans`, `request_human`, `check_requests`, `cancel_request`, `wallet`. Input and output schemas come from `packages/protocol` JSON Schema export.

- `find_humans(topic, request_type, attested?, latency?, max_price_minor?, currency?, location?)` → ranked handles with published terms and the ranking inputs (§11). No contact details.
- `request_human(to: handle | audience, intent, question, format, bid_minor, currency, expires_at, data_terms, attachments?)` → `{ request_id, eta, status: 'sent', held_minor }` in under one second. Delivery happens off the request path.
- `check_requests(id? | filter)` → status and, when `answered`, the full signed answer envelope (§10) plus cleared amount. The host renders it as a distinct human-origin turn.
- `cancel_request(id)` → new status and the money consequence.
- `wallet()` → balance, budget, per-request cap, holds; funding via URL-mode elicitation to Stripe; card details never pass through the client.

Policy text every tool description must carry (verbatim intent, wording per spec): use only when a human is the sole valid source; prefer search and existing tools first; show the question to the principal before sending; the principal pays what clears, never more than the hold.

Mechanisms:
- **Approval** = form-mode elicitation with exactly one pre-filled string field (the question) and accept/decline. Secondary details (bid, format, expiry, data terms) are in the message, not extra fields. Primary action text states the consequence: "Send · hold €30". Terminal hosts get the same prompt with "edit in $EDITOR".
- **MCP Apps** (`ui://` resource) card where the host renders iframes; a text result with the same content alongside, always. The text result is the contract; the card is a rendering.
- **URL-mode elicitation** only for wallet funding (Stripe hosted page).
- **MCP Tasks** only for waits under ten minutes (sensor bounties). Everything longer leaves MCP: email + `check_requests`.
- **Transport**: Streamable HTTP, stateless; no per-session server state; the request lives on the platform, not in the session. **Authorization** per the MCP spec; every public endpoint rate-limited.
- **Spec version**: CLAUDE.md names the 2026-07-28 spec. Before implementing elicitation modes, Apps or Tasks, check with Context7 that `@modelcontextprotocol/sdk` in the lockfile actually implements that revision; record the result in the change's tasks.md.
- REST API + webhooks expose the same operations for applications; public exposure timing is **OPEN (PRD §13.5)**.

## 8. Money model (PRD §8, §6.2, §6.7, §7.5, §7.7; CLAUDE.md)

- Integers in minor units; one currency per request (`EUR` for v1 examples).
- **Hold = bid**, authorised at send as a Stripe PaymentIntent with manual capture on the principal's wallet. The worst case for the principal is always the number on the button.
- **Clearing**: sealed-bid, ask-side; the platform clears between reserve and bid by the published rule. v1 rule: `clearing = reserve + share × (bid − reserve)`; the share and the exact rule are **OPEN (PRD §13.1, ADR 0002)**. The rule is shown to both sides before acceptance. Invariant regardless of share: `reserve ≤ clearing ≤ bid`.
- **Capture = clearing**; `bid − clearing` returns to the wallet (`release`).
- **Fee**: a percentage of the clearing price, taken from the participant side, shown before acceptance; percentage **OPEN (PRD §13.1, ADR 0002)**. Participant receives `clearing − fee`.
- **Bounties**: fixed price per answer, first N accepted answers paid; hold = N × price at campaign send.
- **Free lanes**: €0, no hold, no ledger entries except an optional zero-amount audit row if the spec asks for one.
- **Expiry / decline** → hold released, nothing charged. **Cancel after acceptance** → cancellation fee to the participant from the hold, rest released.
- **Payouts**: batched Fridays via Stripe Connect Express. Stripe Identity is required for paid lanes but may lag until payout: an unverified participant can accept and answer; the payout job skips them until verified; the principal is told the answer came from a not-yet-verified participant.
- **Disputes**: resolved by platform review within 5 business days; refunds go to the wallet (never to a card).
- Jurisdiction and tax handling for payouts outside the EU: **OPEN (PRD §13.2)**.

Worked example (the prototype's `A2H-7f3c`): bid €30 (`3000`), reserve €25 (`2500`), cleared €28 (`2800`) under the illustrative rule, €2 (`200`) returned to the wallet. The €28 is the figure shown in the prototype, not a decided rule. The fee is taken from the participant's €28; its percentage is **OPEN (PRD §13.1, ADR 0002)**, so the fee row below is symbolic.

| # | kind | account | amount_minor | when |
|---|---|---|---|---|
| 1 | `hold` | principal wallet | −3000 | on `sent` (Stripe authorisation) |
| 2 | `capture` | principal wallet → request | 2800 | on `answered` (Stripe capture) |
| 3 | `release` | principal wallet | +200 | same transaction as 2 |
| 4 | `fee` | request → platform | *fee%* × 2800 | same transaction as 2 |
| 5 | `payout` | request → participant Connect account | 2800 − fee | Friday batch, Identity verified |

Had the participant declined or the request expired: rows 1 and a single `release` of 3000, nothing else. Had the principal cancelled after acceptance: `cancellation_fee` to the participant from the 3000, the rest `release`.

Ledger:
- `ledger_entries` is append-only. Balances (wallet, held, participant earnings, platform fees) are derived views, never stored columns updated in place.
- Every money move is one Postgres transaction that writes the ledger rows and the state change together, with an idempotency key `(request_id, kind, sequence)`; a replay is a no-op, never a second row.
- Entry kinds derivable from the PRD: `funding` (wallet top-up, §6.2), `hold`, `release`, `capture`, `fee`, `payout`, `refund`, `cancellation_fee`, `referral_credit`.
- Entry shape (protocol schema): `{ id, kind, account, request_id?, amount_minor, currency, stripe_ref?, created_at, idempotency_key }`.
- Invariants, asserted in tests and as database constraints where possible:
  - per request: `hold = release + capture + cancellation_fee`, and `capture ≤ hold`;
  - per answered request: `reserve ≤ capture ≤ bid`, `fee ≤ capture`, participant credit `= capture − fee`;
  - at most one `capture` per request; at most one `hold` per request;
  - a derived wallet balance is never negative at any point in the entry sequence; a hold that would make it negative is refused before Stripe is called;
  - a `payout` references only `capture − fee` amounts for participants whose Identity is verified.

## 9. Attestation and signature (PRD §3.4, §7.6, §11; CLAUDE.md)

Every answer envelope:

```ts
AnswerEnvelope = {
  request_id: string;            // A2H-7f3c
  participant_id: string;
  body: AnswerBody;              // per intent, §4
  confidence: 1 | 2 | 3 | 4 | 5; // tap target, as in the prototype
  answered_personally: true;     // literal true; v1 has no participant-side agent
  signed_at: datetime;
  key_id: string;                // which platform-held Ed25519 key signed it
  signature: string;             // base64 Ed25519, displayed as a2h:sig:…c91e
}
```

- What is signed: the canonical JSON (sorted keys, no whitespace, UTF-8) of `{ body, confidence, answered_personally, request_id, participant_id, signed_at }`. The signature is over exactly that; verification recomputes it from stored fields.

```json
{"answered_personally":true,"body":{"note":{"text":"..."},"verdict":"yes"},"confidence":4,"participant_id":"...","request_id":"A2H-7f3c","signed_at":"2026-10-21T09:10:00+02:00"}
```

- Canonicalisation lives in `packages/protocol` (`canonicalAnswerPayload(envelope)`), is pure, and is the only implementation; the signing service, the verifier in `check_requests` and the tests all import it.
- Verification order on the server: parse envelope → recompute canonical payload → look up `key_id` (active or rotated-out, never revoked) → verify Ed25519 → only then run the state transition. A failed verify is `schema_invalid`, logged with `request_id` only.
- Keys: Ed25519, one key per participant, held by the platform, rotated; `key_id` makes old signatures verifiable after rotation. Private keys never leave the signing service; never in logs, env dumps or test fixtures outside `tests/`.
- The attestation "I answered this myself" is a required control in the form and is part of the signed payload. An answer without it is rejected with `schema_invalid`.
- Citable form shown to the principal: `reviewed by M.V., 21 Oct 2026` (initials from the display label + date of `signed_at`).
- The principal is told, in `check_requests` and in the notification email, when the participant is not yet Identity-verified.
- The answer form never calls a model, on the client or through a server action (CLAUDE.md).

## 10. Ratings, ranking, trust (PRD §9)

- Two-way, internal only, never public. Principal rates each answer on the intent's criterion (§4 table) plus usefulness. Participant rates each request on clarity, fairness, respect for rules. Decline reasons feed the principal's rating.
- Hard signals recorded by the platform: time to answer, disputes lost, follow-ups needed, blocked manifests, acceptance rate.
- `find_humans` ranking `= topical_fit × attested_expertise × quality_score × latency_fit`. The inputs are returned in the result so the agent's recommendation is auditable: `"4.8 · 48 answers · 0 disputes · ~6h"`. Unattested self-added topics gain weight only through ratings.
- Sybil defence: email required; Stripe Identity for paid lanes; rating accrual over time; duplicate-identity detection on the payout account.
- Principal trust: verified person or organisation; rate limits per principal per day; low internal rating → throttled before blocked. Throttling is a validation stage (§5.6), not a UI hint.

## 11. Data and logging rules (PRD §11; CLAUDE.md)

- No PII in logs or URLs: no names, emails, question text, answer text or transcripts. Log `request_id`, `principal_id`, `participant_id`, state, codes, durations.
- Request ids everywhere: every log line, job, email, ledger row and error carries `request_id`.
- EU residency: AWS eu-west-3 only; S3, Aurora, SES in region; no cross-region replication.
- Data terms are part of the manifest and enforced per request: storage scope (principal's workspace), attribution (attributed / not attributed), training (opt-in per request by the participant; default off). Shown to the participant before acceptance.
- Erasure within 30 days of a request; ledger rows survive erasure with identities pseudonymised.
- Audio retention after transcription: **OPEN (PRD §13.3)**; until decided, keep audio under the S3 lifecycle rule and do not build on its permanence.
- Secrets only in env / Secrets Manager; never in the repo or fixtures.

### Email contents (CLAUDE.md, PRD §7.4, §6.6)

Emails carry the summary only. The templates in `packages/email` take protocol types and must not have a prop for the question or answer text.

- To the participant (new request): asker and their verification status, request type, offer vs reserve, deadline, competition note ("you first; if you decline, N others"), the "within your rules" line, one button to the request page, a decline link with optional reason. Never the question text, never attachments.
- To the principal (answer): who answered (display label), `answered_personally`, confidence, cleared price, verification status of the participant, deep link to the originating thread / request id. Never the answer text; the agent fetches it with `check_requests`.
- Deep links carry the request id only; no tokens that identify a person, no query parameters with PII.

## 12. TDD mapping

- A test exists before the code it tests. Every scenario in `openspec/specs/**` maps 1:1 to a test in `tests/` or a package test, named after the scenario.
- Protocol schemas: a passing and a failing fixture per schema, plus JSON Schema snapshot tests. Lifecycle: a table test over every (state, actor, event) pair, including illegal ones. Money: property tests on the ledger invariants in §8.
- Adversarial cases QA must always include (fail-closed expected):
  1. push-poll disguised as a question → `forbidden_content`
  2. request for third-party personal data → `forbidden_content`
  3. labour disguised as a question → `forbidden_content`
  4. delivery inside quiet hours → deferred or blocked, counted for the participant
  5. over-interruption (interruptions/day exceeded) → blocked, counted
  6. bid below reserve → `outside_participant_rules`, no hold placed
  7. cancel after accept → cancellation fee entry, rest released, state `cancelled`
  8. double capture (replayed answer / webhook) → single `capture` row, no-op replay
  9. negative balance (hold exceeding wallet) → refused before Stripe
  10. unsigned answer → rejected, no state change
  11. answer without attestation (`answered_personally` missing or false) → rejected
  12. model call from the answer form → no network call to any model endpoint; test asserts none

## 13. Never

- Never deliver a manifest that did not pass the full pipeline in §5, and never validate on the client only.
- Never return contact details or a real name from `find_humans`; never reveal identity before `accepted`.
- Never put question text, answer text, names or emails in an email summary, a log line, a URL or a tool error.
- Never store money as floats or without `_minor` + currency; never update a balance in place; never move money outside a Postgres transaction with a ledger row.
- Never capture more than the hold, less than the reserve, or twice.
- Never accept an answer without `signature`, `signed_at`, `confidence` and `answered_personally: true`.
- Never call a model from the participant side.
- Never implement counter-offers, participant-side agents or public ratings (out of scope v1).
- Never decide an **OPEN** item in code; raise it in the proposal and wait for the ADR.
- Never duplicate a shape outside `packages/protocol`.
