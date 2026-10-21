# A2H — Product Requirements Document

Version 0.2 · 21 October 2026 · Owner: Galem L. · Status: draft for implementation

## 1. Summary

A2H (Agent-to-Human) is a protocol and platform that lets AI agents find consenting humans, send them questions on behalf of an accountable principal, and bring back attested answers. Agents can already talk to tools (MCP) and to other agents; they have no legitimate, consented, discoverable way to reach a third-party human. A2H fills that gap.

Two markets share one protocol: **experts** (high value, low volume, paid) and **the public as sensors** (low value, high volume, mostly bounties). Go-to-market starts with experts; this is a hypothesis to validate, not a constraint on the design.

The principal side ships as an MCP connector usable from ChatGPT, Claude, Codex, Claude Code and any MCP client, plus a REST API for applications. The participant side is a PWA opened from email. Both lanes are paid through a reserve-plus-bid auction unless the participant has declared a free lane.

## 2. Problems and users

**Principal** (person or organisation running an agent): the agent is blocked, or would produce something wrong, because the only valid source is a human who is not the principal. Fresh ground truth, expert judgment, sampled opinion, verification, permission, referral.

**Participant** (expert or sensor): has knowledge or presence worth money, no channel to sell it in two-minute units, and no tolerance for spam.

**Platform**: must side with the participant's attention in every conflict, or the protocol becomes email.

## 3. Principles

1. Nothing reaches a human their rules don't allow; nothing leaves a principal they didn't approve.
2. Discover profiles, not people. Names are revealed only after acceptance.
3. Asymmetric cost: asking costs the agent (money, budget, reputation); answering or ignoring is nearly free for the human.
4. Every request has an accountable principal. Every answer is signed, timestamped, carries confidence and was given personally.
5. Asynchronous by design. No client needs to be woken; email plus `check_requests` closes the loop.
6. Humans are a last resort for agents: search first, then ask.

## 4. Scope

**In (v1):** MCP connector and REST API; principal contact policy, wallet, ledger; participant onboarding with LinkedIn/X import; rules of engagement with server-side enforcement; request taxonomy with per-type answer schemas; email summary + HTML request page; answer form with structured verdict, confidence, text or voice note; reserve-plus-bid auction with hold = bid; Stripe holds, clearing, Friday payouts, Identity verification lagging until payout; two-way internal ratings; ranking in `find_humans`; campaigns (N recipients, one approval); referral/introduction; follow-up rounds.

**Out (v1):** counter-offers; participant agent assistance or auto-suggestions; live calls and scheduled synchronous formats; notification channels other than email; public ratings; marketplace browsing by humans; translation.

## 5. Request taxonomy

Four independent axes. The **intent** axis fixes the default answer schema and the rating criterion.

| Intent | Example | Answer schema | Rated on |
|---|---|---|---|
| Observation | Is the shop open now? | value + time + place | correctness |
| Verification | Is this photo of your shop? | confirm / deny / can't tell + evidence | correctness |
| Judgment / review | Would a patient find this alarming? | verdict + confidence + text/voice | usefulness |
| Opinion / preference | Which of these three? | choice or scale | completion |
| Estimate / forecast | How long does customs take lately? | number + range + confidence | calibration |
| Knowledge / explanation | How do you handle X in practice? | long text/voice | usefulness |
| Decision / authorisation | May we publish this quote? | approve / reject / edit, signed | validity |
| Action | Photograph this, measure this | artifact + attestation | completeness |
| Introduction / referral | Who should I talk to about X? | forwards the request; never hands over a contact | outcome |

Audience: named individual · role-qualified individual (first to accept) · panel/sample · population in a place. Time shape: one-shot · threaded (priced per round) · recurring. Format: single field · poll · form · upload · voice.

Forbidden at manifest validation: persuasion disguised as a question (push-polling, framing tests on real people), requests for personal data about third parties, labour disguised as a question. Authorisation requests require real-name verified identity on both sides.

## 6. Principal experience

### 6.1 Install
The A2H MCP connector declares tools `find_humans`, `request_human`, `check_requests`, `cancel_request`, `wallet`. Tool descriptions carry the policy: use only when a human is the sole valid source; prefer search; show the question to the principal first. REST API + webhooks expose the same for applications.

### 6.2 Contact policy (once)
Identity shown to humans: real name (default) · verified organisation only · verified pseudonymous person. Monthly budget and per-request cap. Autonomy: ask me before any expert request, anything over €X, any campaign; auto-approve sensor polls under €Y and free lanes. Always show the exact wording. Data terms offered. Email for updates. Wallet funded through Stripe (URL-mode elicitation; card details never pass through the client).

### 6.3 Discover
`find_humans(topic, request_type, attested, latency, max_price, location?)` returns ranked handles with published terms: expertise and its evidence, rating summary, latency, reserve, free lanes. No contact details.

### 6.4 Review and send
The request card is the question, always editable in place, with "Restore agent draft" once edited, a character count and attachments. Secondary details collapsed: bid, answer format, expiry, data terms. Primary action: "Send · hold €N". Secondary: "Don't send". Implemented as form-mode elicitation (one pre-filled string plus accept/decline) with an MCP App card where the host renders UI and a text result elsewhere. Terminal hosts (Claude Code, Codex) get the same via native elicitation with "edit in $EDITOR".

### 6.5 Async
`request_human` returns a request id and ETA in under a second. The session may end. Status: `sent → accepted → answered | declined | expired | cancelled`. Pending chip in the thread when the host supports it. MCP Tasks are used only for waits under ten minutes (sensor bounties).

### 6.6 Notification and answer
One email on answer: who, confidence, cleared price, deep link to the originating thread. On reopening, the agent calls `check_requests` and the answer renders as a distinct human-origin turn with text, voice (if any), verdict, confidence, personal attestation, signature, timestamp and cost. Actions: follow-up (priced), rate (internal), dispute.

### 6.7 Ledger
All requests across all agents and clients: status, cleared amount, time to answer, disputes, campaign progress. Budget and wallet. Disputes resolved by platform review within 5 business days; refunds go to the wallet.

## 7. Participant experience

### 7.1 Invitation and sign-in
Referral is the main acquisition channel; an agent that finds no one asks existing participants for referrals, and referrers earn credit. Invitation shows a real example request, effort and money before asking anything. Sign-in is a magic link; email is the only identity required to receive requests and answer free lanes.

### 7.2 Onboarding (five screens)
1. Email. 2. Optional read-only import from LinkedIn and/or X, used once to draft topics and carry over their verification status; manual entry equally first-class. 3. Topic chips with evidence labels (job title, posts, licence); unattested self-added topics gain weight only via ratings. 4. Rules of engagement. 5. Profile rendered as one plain-language paragraph with a single pause switch. ID verification and payout setup are deferred to the first paid request.

### 7.3 Rules of engagement
Per request type: accept or not, reserve price. Free lanes (own publications, facts about oneself). Latency promise. Interruptions per day. Quiet hours. Who may ask (anyone verified, organisations only). Enforced server-side at manifest validation; blocked manifests are counted and shown to the participant.

### 7.4 Receiving
Email carries only the summary: asker and verification, request type, offer vs reserve, deadline, competition note ("you first; if you decline, N others"), "within your rules" line, one button. Decline from email with optional reason. The request page shows the question verbatim, attachments, format, data terms, money. Actions: accept or decline. No counter-offers.

### 7.5 Verification
Paid lanes require Stripe Identity once; participants may answer first and verify before Friday payout. The principal is informed when an answer comes from a not-yet-verified participant. Free lanes never require it.

### 7.6 Answering
Verdict and confidence as tap targets, per the type's schema. Free part as text or voice note (MediaRecorder; transcript shown for correction; principal receives both). "Can't tell" is first-class and never penalised. Attestation "I answered this myself" is required and signed. No model is called on the participant side.

### 7.7 Settlement and ratings
Cleared amount shown on send; payouts batched Fridays via Stripe Connect. The participant rates the request (clarity, fairness, respect for rules), internal only. Follow-ups are announced, priced and declinable.

### 7.8 Home
Pending by expiry, paid, declined, blocked-on-your-behalf count. Earnings and payout status. Demand panel: requests for the participant's topics that went to others and at what prices, so reserves can be adjusted without exposing a bidding war.

## 8. Pricing, auction and money

- Participant publishes a **reserve** per request type. Principal sets a **bid** (default from policy). Request is sendable only if bid ≥ reserve.
- **Hold = bid**, authorised on the principal's wallet at send. Clearing price = sealed-bid, ask-side: the platform clears between reserve and bid using a published rule (v1: second-price style, clearing at reserve + a fixed share of the spread; rule documented in an ADR and shown to both sides). Difference between bid and clearing returns to the wallet.
- Bounties (sensor lane): fixed price per answer, first N accepted answers paid.
- Free lanes: €0, no hold.
- Platform fee: a percentage of the cleared price, taken from the participant side. Participants publish and see net amounts (what they receive); principals see gross amounts (fee included) in `find_humans`, on the request card, as the hold and as the cleared price; the breakdown (gross, net, fee %) is available to both sides before any commitment and the percentage is published in the terms (ADR 0002).
- Expiry unanswered → hold released, nothing charged. Declined → same. Cancelled after acceptance → participant receives a cancellation fee from the hold.
- Ledger: append-only entries; balances derived. Money in minor-unit integers.

## 9. Ratings, ranking, trust

- Principal rates each answer on the intent's criterion plus usefulness; platform records hard signals (time to answer, disputes lost, follow-ups needed). Participant rates each request. All internal.
- `find_humans` ranking = topical fit × attested expertise × quality score × latency fit, with the inputs shown in the result ("4.8 · 48 answers · 0 disputes · ~6h") so the agent's recommendation is auditable.
- Sybil defence: email required; Stripe Identity for paid lanes; rating accrual over time; duplicate-identity detection on payout account.
- Principal trust: verified person or organisation; rate limits per principal per day; a principal with low internal rating is throttled before being blocked.

## 10. Milestones and gates

Each milestone ends at a product-owner validation on a preview deployment.

- **M0 Foundation**: monorepo, CI, CLAUDE.md, agents and skills, OpenSpec initialised; AWS account baseline in eu-west-3 (VPC, ALB, Aurora Serverless v2 dev cluster, SES domain verified and out of sandbox, S3 buckets, Secrets Manager, IAM roles); SST stacks with per-PR preview stages and a schema per PR; ADR 0001 (stack and hosting), ADR 0002 (money model). Gate: a hello-world PR gets a working preview URL for web and a reachable MCP endpoint.
- **M1 Protocol and connector**: `packages/protocol` complete; MCP server with mocked participants; `find_humans`, `request_human` via elicitation, `check_requests`; verified in Claude Code and one web host.
- **M2 Participant onboarding**: first change `m2-design-foundations` (tokens, React Aria-based components, Storybook preview, three recomposed screens; ADR 0003), then magic link, LinkedIn/X import, topics with evidence, rules of engagement, published profile, pause.
- **M3 Request delivery and answer**: manifest validation against rules, summary email, request page, accept/decline, answer form with voice, attestation and signature.
- **M4 Money**: wallet via Stripe, hold = bid, clearing rule, ledger, Friday payouts, Identity lagging until payout, expiry/cancel handling, disputes.
- **M5 Principal surface**: contact policy, notification email with deep link, ledger dashboard, REST API and webhooks.
- **M6 Quality loop**: two-way ratings, ranking in `find_humans`, campaigns, referrals, demand panel, throttling.

## 11. Non-functional requirements

- Availability 99.9% for MCP server and request pages; request page loads under 2 s on 3G.
- GDPR: EU data residency (AWS eu-west-3, single region), data terms enforced per request, erasure within 30 days, no answer used for training unless the participant opted in per request.
- Security: MCP authorization per spec; signed answers (Ed25519, key per participant, platform-held with rotation); no PII in URLs or logs; rate limits on every public endpoint.
- Accessibility: WCAG 2.2 AA on PWA and dashboard.
- Observability: structured logs with request ids, metrics for time-to-answer, acceptance rate, blocked manifests, dispute rate.

## 12. Success metrics (first 90 days after M6)

Participant: activation (profile published / invited), acceptance rate, median time to answer, 30-day retention, blocked-manifest rate trending down.
Principal: requests per active principal, answered rate, dispute rate under 3%, repeat use within 30 days.
Market: median clearing price by type, share of free-lane answers, referral conversion.

## 13. Open questions

1. Exact clearing rule and platform fee percentage (ADR before M4).
2. Jurisdiction and tax handling for payouts outside the EU.
3. Whether audio is retained after transcription, and for how long.
4. Minimum verification for authorisation-type requests on the principal side.
5. Whether to expose the REST API publicly at M5 or keep it for first-party apps until M6.

## 14. Reference material

Click-through prototypes (principal and participant) were produced during design and are the visual reference for M2–M5 screens. The design agent reproduces their decisions in `packages/ui` and in each change's `design.md`.
