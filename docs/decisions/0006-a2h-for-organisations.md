# ADR 0006: A2H is built for organisations

- Status: proposed (owner decisions of 2026-11-11 recorded; takes effect when the owner approves PRD v0.3)
- Date: 2026-11-11
- Deciders: product owner (Galem L.), PM agent
- Scope: who A2H is for, how it is deployed and sold, and which rules replace the money model inside an organisation. Governs `docs/PRD.md` from v0.3 and every change proposed after `m2-attachments`.
- Related: `docs/PRD.md` v0.3; ADR 0001 (stack and hosting; provider-neutral business logic); ADR 0002 (money model, now the later phase); ADR 0007 (licence and packaging, to be written).

## Context

PRD v0.2 described a public two-sided market: agents of any principal reach consenting outside experts and members of the public, paid per answer through a reserve-plus-bid auction, on one platform we host. M0 and M1 are done under that plan; within M2 the design foundations, the hosted approval page and attachments are built. Participant onboarding, delivery, answering, money and ratings are not built.

On 2026-11-11, before the participant-onboarding change was proposed, the owner changed the direction.

## Decision

Owner decisions:

1. **A2H is designed for organisations.** A company installs it in its own cloud account so that its agents can reach its own people.
2. **Internal first.** Company-to-company requests and outside experts come later, on the same protocol.
3. **Open source with a business model**, distributed through cloud marketplaces, AWS first.
4. **First customers:** technology companies that already use agents widely. A hypothesis to validate.
5. **The human in the loop is any member of the organisation**, not only whoever launched the agent. Two uses share the protocol: agents drawing on colleagues ("multi-player AI"), and a human decision before risky agent actions (guardrail).
6. **The name stays A2H**, although another protocol of the same name exists (see Field).
7. **A person's rules win over company policy.** A request that policy requires, and that no one may receive yet, waits until someone is available.
8. **Every legitimate request reaches the person; agents see the person's load** and are expected to ask wisely.
9. **Answers are reusable across the organisation**, and answer reuse is a paid feature.
10. **Edition rule:** free covers what one team needs to run A2H safely; paid covers what an organisation needs to run it at scale. Nothing that enforces the one rule is paid.

## Field (web research, 2026-11-11)

Sources are public pages read on that date. Claims marked "not verified" rest on directory listings or secondary reports.

- **Most tools gate a tool call and ask the agent's own user or a preset approver.** Agent frameworks offer a pause-and-resume primitive and leave the choice of person to the application: [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [Microsoft Agent Framework](https://learn.microsoft.com/agent-framework/workflows/human-in-the-loop), [Google ADK tool confirmation](https://adk.dev/tools-custom/confirmation/), [CrewAI](https://docs.crewai.com/en/enterprise/guides/human-in-the-loop), [Temporal](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python), [Inngest](https://www.inngest.com/docs/ai-patterns/human-in-the-loop).
- **Approval products that route to other people:** [withHuman](https://withhuman.ai) routes approvals by agent, tool or payload with escalation and on-call paging, and describes an open-source, self-hostable core with its own approval protocol (licence not verified). [gotoHuman](https://www.gotohuman.com/pricing) offers a review inbox with routing on higher tiers. [Microsoft Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-advanced-approvals) sends multistage approvals and information requests to any assigned user in Outlook or Teams. [ServiceNow](https://newsroom.servicenow.com/press-releases/details/2026/ServiceNow-expands-AI-Control-Tower-to-discover-observe-govern-secure-and-measure-AI-deployed-across-any-system-in-the-enterprise/default.aspx) exposes its approval chains to external agents.
- **Same name.** Twilio published an open-source specification called [A2H (Agent-to-Human)](https://www.twilio.com/en-us/blog/products/introducing-a2h-agent-to-human-communication-protocol) in February 2026, for an agent reaching its human principal across channels, with signed evidence; its [Ola](https://www.twilio.com/en-us/blog/developers/introducing-ola-agent-control-communications-channel) product builds on it. Whether that specification allows a recipient other than the principal was not verified.
- **Not found in any product:** rules owned by the recipient and enforced by the server (quiet hours, daily limits, accepted request types); request types beyond approval sent to colleagues; finding the person from ownership or expertise; answers attested as given personally; reuse of answers. A July 2026 [survey of asynchronous approval protocols](https://zylos.ai/research/2026-07-30-async-human-in-the-loop-approval-protocol-convergence) reaches the same conclusion on routing and reviewer attention.
- **Approval alone is a weakening wedge.** Habituation is documented ([study of 400 reviewers](https://arxiv.org/html/2606.22721v1)), and vendors are replacing prompts with automated classifiers ([Anthropic, Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)).
- **Demand.** Public incidents of agents destroying production data ([IANS](https://www.iansresearch.com/resources/all-blogs/post/security-blog/2026/05/04/i-violated-every-principle---ai-agent-erases-company-s-data-in-seconds)) and a survey showing falling trust in automated production changes ([VentureBeat](https://venturebeat.com/orchestration/the-share-of-enterprises-trusting-ai-agents-to-make-production-changes-on-their-own-has-fallen-from-75-to-56-vb-intelligence-finds)) support the guardrail. For agents blocked waiting on a colleague, only vendor commentary was found, no measured data.

## Consequences

**Kept as built:** `packages/protocol` (request types, manifest, validation, attestation), the MCP connector, the hosted approval page, attachments and their scanning, principal sign-in and connector authorization (ADR 0004), the design foundations (ADR 0003).

**Changes:**

- **Money leaves the first release.** No auction, holds, payouts or identity verification between colleagues. ADR 0002 describes the later phase. The protocol keeps its money fields; inside an organisation every request uses the free lane.
- **The brake on over-asking becomes attention, not price:** load shown to agents, a quota per asker, role-addressed requests, waiting, and answers found before people are asked (PRD §8, §9).
- **The one rule gains a clause:** company policy cannot override a person's rules (PRD §3, principle 2). CLAUDE.md's statement of the rule is unchanged and already covers it.
- **Participants come from the organisation's identity provider**, not from invitation and LinkedIn/X import. The owner's sign-in allow-list becomes a development-stage tool.
- **Deployment becomes single-tenant and self-hosted.** AWS-specific parts (web hosting, GuardDuty scanning, SES, the SSM allow-list, previews) move behind interfaces with an AWS implementation first. ADR 0001's provider-neutral rule already points this way.
- **Notifications extend beyond email** (Slack; Teams in the paid edition). v0.2 excluded other channels.
- **Employee data.** Response times and counts per person are workplace monitoring in the EU. No ratings of individuals are planned; a data-protection position is needed before the first install (PRD §16, question 3).
- **Licence.** The repository is public without a licence file. ADR 0007 decides the licence of the free part, how paid code is kept apart, and the marketplace packaging.
- **Milestones are re-planned** (PRD §13).

**Risks:**

- An approval product adds recipient rules, or a suite vendor bundles information requests to colleagues, before A2H is installable.
- Technology companies settle for a message in a chat channel. Answer reuse and attention rules are the reply; both must be visible in the first install.
- Two projects named A2H confuse buyers and searches. Accepted by the owner; a trademark check is the owner's to commission.
- The paid line is drawn wrongly: too little free and nobody tries it, too much free and nobody pays. The edition table (PRD §11) is a proposal to revisit after the first installs.
