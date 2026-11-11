# A2H — Product Requirements Document

Version 0.3 (draft for owner review) · 11 November 2026 · Owner: Galem L. · Status: direction change, not yet approved

Version 0.2 described a public marketplace of experts and "sensors" paid by auction. Version 0.3 re-aims the product at organisations (ADR 0006). What v0.2 said about the public market is kept, shortened, in §17 as the later phase; its full text is in git history.

Lines marked **(owner)** are decisions the owner made on 2026-11-11. Lines marked **(PM proposal)** are the PM's defaults and stand only if the owner accepts them at review. Everything unmarked is carried over from v0.2 or follows directly from an owner decision.

## 1. Summary

A2H (Agent-to-Human) lets an organisation's AI agents reach the right person inside that organisation, under that person's own rules, and bring back a signed answer the person gave themselves.

An organisation installs A2H in its own cloud account **(owner)**. Its agents connect through an MCP server. An agent, acting for an accountable employee or service owner, sends a structured request (a question, a verification, a request for judgment, a decision to approve) to any member of the organisation, not only to whoever launched the agent **(owner)**. The answer comes back structured, signed, attributed and dated, even if the agent's session has ended.

Two uses share one protocol **(owner)**:

- **Multi-player AI.** Agents draw on colleagues' knowledge, judgment and verification. Answers can be found and reused by other agents in the organisation **(owner)**, so A2H becomes the organisation's memory of human answers.
- **Guardrail.** The organisation requires a human answer before certain agent actions. The action stays blocked until someone answers.

A2H is open source with a paid edition (§11) and is distributed through cloud marketplaces, AWS first **(owner)**. Internal use comes first; company-to-company requests and outside experts come later (§17) **(owner)**. The first customers we expect are technology companies that already use agents widely **(owner; a hypothesis to validate)**.

## 2. Problems and users

**Asker (principal).** An employee running an agent, or the named owner of an autonomous agent. The agent is blocked, or would do something wrong or risky, because the only valid source is a colleague: the person who owns the service, knows why a decision was made, or must approve the action.

**Participant.** Any member of the organisation. They hold knowledge and authority agents need, and they have no tolerance for a stream of machine-written interruptions.

**Organisation.** Wants agents to act faster without acting blind, wants a record of who decided what, and wants answers given once to stop being asked again.

**The product** must side with the participant's attention in every conflict, or it becomes one more noisy channel.

**Where the field stands (research of 2026-11-11, summarised in ADR 0006).** Existing tools gate an agent's tool call and ask the agent's own user or a preset approver. None found combines: any colleague chosen by role, ownership or expertise; rules owned by the recipient; request types beyond approval; signed, personally given answers; reuse of answers. Approval alone is a weakening wedge: people approve almost everything, and vendors are automating it.

## 3. Principles

1. Nothing reaches a person that their rules don't allow; nothing leaves a principal they didn't approve.
2. **A person's rules win over company policy** **(owner)**. Policy can require a human answer; it cannot override when a person is reachable. A request that no one may receive yet waits.
3. **Nothing legitimate is dropped; not everything interrupts** **(owner)**. A valid request is always delivered to the person's queue. The person's rules govern when and how often they are notified.
4. Asking has a cost for the agent, but not in money: agents see the person's load before asking **(owner)**, each asker has a quota per person **(PM proposal)**, and a question already answered is found, not asked again **(owner)**.
5. Every request has an accountable principal. Every answer is signed, timestamped, carries confidence and was given personally. No model assists the participant.
6. Asynchronous by design. No client needs to be woken; a notification plus `check_requests` closes the loop.
7. People are a last resort for agents: search first (including earlier answers), then ask.
8. The guardrail fails closed. An action that needs a human answer does not happen without one.
9. Protection is never a paid feature. Anything that enforces principles 1–3 is in the free edition (§11) **(owner agreed the rule)**.

## 4. Scope

**In (first release, internal use):** MCP connector; hosted approval page with attachments (built); sign-in through the organisation's identity provider; profiles, teams and roles; personal rules of engagement with server-side enforcement; request taxonomy with per-type answer schemas; requests to a named person or to a role; queue, load and quotas; notification by email and Slack; request page and answer form (text or voice); signed, attested answers; the record of requests and answers; a single guardrail rule; a self-hosted install.

**In (paid edition, §11):** answer reuse; policy engine; connectors for ownership, on-call and directory data; SAML and automatic provisioning; Microsoft Teams; audit export; dashboards; high availability and support.

**Out (first release):** money in any form between colleagues; public discovery; participant agent assistance or auto-suggestions; live calls; ratings of individual employees (§16, question 3); translation.

**Later (§17):** company-to-company requests, outside experts, pricing and payouts.

## 5. Request taxonomy

Four independent axes, unchanged from v0.2. The **intent** axis fixes the default answer schema.

| Intent | Example inside a company | Answer schema | Reusable (§9) |
|---|---|---|---|
| Observation | Is the staging cluster in use right now? | value + time + place | no (stale at once) |
| Verification | Is this the current runbook for failover? | confirm / deny / can't tell + evidence | yes |
| Judgment / review | Is this API change acceptable for mobile clients? | verdict + confidence + text/voice | yes |
| Opinion / preference | Which of these three names? | choice or scale | yes |
| Estimate / forecast | How long will the migration freeze last? | number + range + confidence | yes, dated |
| Knowledge / explanation | Why does this service retry three times? | long text/voice | yes |
| Decision / authorisation | May the agent delete these production tables? | approve / reject / edit, signed | **never** |
| Action | Check the badge reader on floor 3 | artifact + attestation | no |
| Introduction / referral | Who should I ask about billing exports? | forwards the request; names a person or role | yes |

The "Reusable" column is a PM proposal, except that answer reuse itself is an owner decision.

Audience: named individual · **role-qualified individual (first available member of a team or role)** · panel/sample. Time shape: one-shot · threaded · recurring. Format: single field · poll · form · upload · voice.

Forbidden at manifest validation: persuasion disguised as a question, requests for personal data about third parties, labour disguised as a question (a request that asks the person to do the agent's task for it), and any request used to assess the participant.

## 6. Asker experience

### 6.1 Install
The organisation's A2H MCP server declares `find_humans`, `request_human`, `check_requests`, `cancel_request`, and, in the paid edition, `find_answers`. Tool descriptions carry the policy: use only when a person is the sole valid source; search first; show the question to the principal first. Sign-in is through the organisation's identity provider.

### 6.2 Asking policy (once per principal)
Autonomy: ask me before every request, or auto-approve named request types to named teams. Always show the exact wording. Autonomous agents (no person at the keyboard) act for a named service owner, who is the accountable principal and sets this policy **(PM proposal)**.

### 6.3 Discover
`find_humans(topic, request_type, team?, role?)` returns people and roles with: the evidence for their fit (team, role, ownership, topics), the request types they accept, **their current load (queue length and expected wait) (owner)**, and when they are next reachable. In the paid edition, matching earlier answers are returned first.

### 6.4 Review and send
Unchanged and built: the hosted approval page (changes `m2-approval-page`, `m2-attachments`). The question is editable in place; attachments are checked before Send. The primary action becomes "Send"; there is no hold and no price inside an organisation.

### 6.5 Async
`request_human` returns a request id and an expected time at once. Status: `sent → accepted → answered | declined | expired | cancelled`, plus **`waiting`** when no one may receive the request yet, with the time it will be delivered **(owner: the request waits)**.

### 6.6 Answer
On reopening, the agent calls `check_requests` and the answer renders as a distinct human-origin turn: text, voice if any, verdict, confidence, attestation, signature, timestamp, who answered. Actions: follow-up, mark as unclear.

### 6.7 Record
Every request and answer across all of a principal's agents, with status and time to answer. Organisation-wide export is in the paid edition.

## 7. Participant experience

### 7.1 Joining
A person exists in A2H once they sign in through the identity provider, or once the directory is synchronised. No invitation, no external import. Whether a person can refuse to be reachable at all is open (§16, question 1).

### 7.2 Profile
Team, role and topics. In the free edition these come from the identity provider's groups and from what the person enters. In the paid edition, connectors add code ownership, on-call rotas and directory data, each shown as evidence the person can correct.

### 7.3 Rules of engagement
Per request type: accept or not. Reachable hours. Interruptions per day. Latency promise. Who may ask (anyone, named teams). **Urgent requests reach a person outside their hours only if that person opted in, for example while on call (PM proposal).** Rules are enforced server-side at manifest validation; requests held or refused on the person's behalf are counted and shown to them.

### 7.4 Receiving
A notification carries only the summary: who asks and for whom, request type, deadline, "within your rules". Never the question text. Channels: email and Slack in the free edition **(PM proposal)**, Microsoft Teams in the paid one. The request page shows the question verbatim, attachments and format. Actions: accept, decline with an optional reason, or forward to a better person.

### 7.5 Queue
Every valid request is in the person's queue. Notifications follow their rules; the queue can be opened at any time. The queue shows what waits, for whom, and since when.

### 7.6 Answering
Unchanged from v0.2: verdict and confidence as tap targets, free part as text or voice note with a correctable transcript, "can't tell" first-class, the attestation "I answered this myself" required and signed. The participant may mark an answer "for this asker only" **(PM proposal)**.

### 7.7 Home
Waiting, answered, declined, held-on-your-behalf count. Their rules and a single pause switch. In the paid edition: how often their answers were reused.

## 8. Attention, load and quotas

This replaces v0.2's pricing as the brake on over-asking.

- **Load is visible (owner).** Each person's queue length and expected wait are returned by `find_humans` and shown on the approval page before Send.
- **Quota per asker (PM proposal).** A principal and their agents may send a set number of requests to any one person per week; the default is set by the organisation and can be lowered by the person. Over quota, the request is refused before the approval page, and the refusal says when it resets.
- **Role-addressed requests spread load (PM proposal).** A request to a team or role goes to the first member whose rules allow it, preferring the shortest queue.
- **Waiting, not dropping (owner).** A request no one may receive yet is `waiting` and delivered when the first person becomes reachable. The asker sees the expected time and may cancel.
- **Budget code already built** (monthly budget, daily request limit, per-request cap) is kept: the money parts lie dormant until §17; the request limits become the first form of the quota **(PM proposal)**.

## 9. Answer reuse (paid edition)

**(owner)** An answer given to one agent can be found and reused by other agents in the organisation.

- `find_answers(question, topic?)` returns earlier answers with who answered, when, the question as asked, confidence and signature.
- A reused answer stays attributed and dated. The agent sees its age and may ask again; asking again about an answer the person marked still valid needs the principal's explicit approval **(PM proposal)**.
- Decisions and authorisations are never reusable. An answer marked "for this asker only" is never returned to others. Attachments follow the answer's visibility. **(PM proposal)**
- The participant can withdraw or correct an answer; the correction is signed and replaces the earlier one in results **(PM proposal)**.
- In the free edition the server still tells the agent that a matching answer exists, without showing it, so the person is not asked twice **(PM proposal; §16, question 4)**.

## 10. Company policy (guardrail)

- A policy says: this kind of agent action needs an answer of type decision from this role or team. The free edition allows one such rule; the paid edition adds multi-step approvals, escalation chains and separation of duties **(PM proposal)**.
- A policy request is addressed to a role, never forced onto a named person outside their rules (principle 2).
- The action stays blocked until answered (principle 8). How the agent's runtime enforces the block (a gateway in front of tools, or the agent's own harness) is a design question for the change that builds it.
- A decision is bound to the exact action it approved and expires; it is never a standing permission **(PM proposal)**.

## 11. Editions and distribution

**The rule (owner agreed):** free covers what one team needs to run A2H safely; paid covers what an organisation needs to run it at scale. Nothing that enforces principles 1–3 is paid.

| Area | Free | Paid |
|---|---|---|
| Core | Request types, validation, accountable principal, MCP connector, approval page, attachments, signed and attested answers | – |
| People | Personal rules, pause, queue, load shown to agents, basic quota | – |
| Finding people | Profiles, teams and roles from sign-in and by hand | Connectors: code ownership, on-call rotas, directory; suggested expertise |
| Sign-in | Single sign-on (OIDC) | SAML, automatic provisioning (SCIM) |
| Channels | Email, web inbox, Slack | Microsoft Teams, others |
| Guardrail | One policy rule | Policy engine: multi-step, escalation, separation of duties |
| Knowledge | "An answer exists" signal | Answer reuse: search, freshness, visibility **(owner)** |
| Audit | View the record | Export to security tools, retention controls, tamper-evident log |
| Insight | – | Dashboards per team (never per person; §16, question 3) |
| Operations | Single-instance install | High availability, upgrade tooling, support |
| Later | – | Company-to-company, outside experts, payments |

Apart from answer reuse, every placement in this table is a PM proposal.

**Licence.** The repository is public and has no licence file today, so it is not yet open source. The licence of the free part and the way paid code is kept apart are decided in ADR 0007, after the research in progress.

**Distribution.** The free edition comes from the repository. The paid edition is listed on AWS Marketplace first, then Azure and Google Cloud. Packaging and entitlement follow ADR 0007.

## 12. Deployment and architecture

- **Single-tenant, self-hosted.** One organisation per install, in its own cloud account. Our own hosted stages (dev, previews) remain for development.
- **Cloud-neutral package.** Containers plus Postgres through a connection string. Today the web app's hosting, the malware scanner (GuardDuty), email (SES), the sign-in allow-list (SSM) and previews are AWS-specific; each becomes an interface with an AWS implementation first. Business logic is already provider-neutral (ADR 0001).
- **Identity.** The organisation's identity provider replaces the owner's allow-list. Magic links remain for development stages only.
- **Stack** otherwise unchanged (CLAUDE.md, ADR 0001).

## 13. Milestones

Done: **M0 Foundation**, **M1 Protocol and connector**. Within M2, done: design foundations, approval page, attachments.

Re-plan **(PM proposal; order to be confirmed, §16 question 6)**:

- **M2 People.** Sign-in through an identity provider; profiles, teams, roles; personal rules; pause; queue and load.
- **M3 Delivery and answer.** Validation against rules; requests to a role; waiting; notification by email and Slack; request page; answer form with voice; attestation and signature.
- **M4 Install.** Licence; cloud-neutral package; provider interfaces; install guide; first public release of the free edition.
- **M5 Paid edition.** Answer reuse; entitlement; AWS Marketplace listing; then policy engine, connectors, audit export.
- **M6 Beyond the company.** §17.

Each milestone ends at a product-owner validation on a preview deployment.

## 14. Non-functional requirements

- Availability and performance: request page loads under 2 s; the install documents what the organisation must run to reach 99.9%.
- Privacy: data stays in the organisation's account. Employee data is processed for delivering requests, not for assessing people (§16, question 3). Erasure of a person's profile and rules on request; their signed answers follow the organisation's retention policy.
- Security: MCP authorization per spec; signed answers (Ed25519, key per participant, held by the install, with rotation); no PII in URLs or logs; rate limits on every endpoint.
- Accessibility: WCAG 2.2 AA.
- Observability: structured logs with request ids; metrics for time to answer, acceptance rate, held and refused requests, reuse rate.

## 15. Success metrics (first 90 days after the first install)

Participant: share of members with rules set, acceptance rate, median time to answer, held-on-your-behalf trending down, pauses per person.
Asker: requests per active principal, answered rate, repeat use within 30 days.
Organisation: share of questions resolved by an earlier answer (paid), guarded actions decided, median wait for a guarded action.
Adoption: installs, installs still active after 30 days, free-to-paid conversion.

## 16. Open questions

1. **Can an employee refuse to be reachable at all,** or only shape how (hours, types, limits)? The one rule suggests they can pause without limit; the organisation may see that differently.
2. **Urgent requests:** is opt-in by the person (for example while on call) the only way past their hours? (PM proposal: yes.)
3. **Employee monitoring.** Response times and counts per person are workplace monitoring in the EU (works councils, GDPR). PM proposal: no ratings of individuals, dashboards per team only, and a documented data-protection position before the first install.
4. **Free "answer exists" signal:** keep it free (protects the person) or make reuse wholly paid?
5. **Slack in the free edition:** PM proposal yes; without it, technology companies will not try A2H.
6. **Order of milestones:** people and delivery first (M2, M3), or the install and licence first (M4) so outsiders can try what exists?
7. **Name.** The owner keeps "A2H" although Twilio published a protocol of the same name in February 2026 **(owner)**. A trademark check is the owner's to commission; whether to interoperate with that specification is open.
8. **Quota defaults** and who may change them.
9. Whether audio is retained after transcription, and for how long (carried over).

## 17. Later: beyond the company

From v0.2, kept as the direction for after internal use works:

- **Company-to-company:** one organisation's agents ask another's people, each side under its own rules and policies.
- **Outside experts:** consenting individuals reachable by profile, not by name ("discover profiles, not people"), paid per answer.
- **Money:** reserve-plus-bid, hold = bid, clearing rule, append-only ledger, payouts, identity verification for paid lanes (ADR 0002).
- The protocol keeps the fields these need (lane, bid, reserve, data terms). Inside an organisation every request uses the free lane.

## 18. Decision log

| Date | Decision | By |
|---|---|---|
| 2026-11-11 | A2H is designed for organisations: open source, installed by a company for its own agents and people | owner |
| 2026-11-11 | Internal first; company-to-company and outside experts later | owner |
| 2026-11-11 | Open source with a business model; cloud marketplaces, AWS first | owner |
| 2026-11-11 | First customers expected: technology companies using agents widely (hypothesis) | owner |
| 2026-11-11 | The human in the loop is any member of the organisation; multi-player AI and guardrail | owner |
| 2026-11-11 | The name stays A2H | owner |
| 2026-11-11 | A person's rules win over company policy; the request waits | owner |
| 2026-11-11 | Agents see a person's load; every legitimate request reaches the person | owner |
| 2026-11-11 | Answers are reusable across the organisation; answer reuse is a paid feature | owner |
| 2026-11-11 | Edition rule: free for one team to run safely, paid for an organisation at scale | owner |

## 19. Reference material

Click-through prototypes (principal and participant) from the v0.2 design remain the visual reference for the request page and answer form. Field research of 2026-11-11 is summarised in ADR 0006.
