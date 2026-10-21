---
name: a2h-design
description: Load when building or reviewing any A2H UI (participant PWA, principal dashboard, MCP App card, terminal rendering), any email template in packages/email, or a change's design.md; it fixes tokens, the colour role model (human plain, machine coloured), core patterns, copy, states, accessibility and the Playwright review.
---

# A2H design skill

Sources of truth, in order: `docs/PRD.md` (§6, §7, §8, §11), `CLAUDE.md` (the one rule, engineering rules), `docs/decisions/0003-design-foundations.md` (component base, tokens, colour roles, typography, card guest rules) and `docs/decisions/0002-money-model.md` Decision 4 (gross to principals, net to participants), then the click-through prototypes `docs/prototypes/principal.html` and `docs/prototypes/participant.html`. **The prototypes are the reference for product behaviour and copy only; their colours and fonts are not normative** (ADR 0003). Where a prototype and the PRD or an ADR disagree, the PRD/ADR wins; the known cases (live calls, platform fee, participant-side agent, tinted human card) are marked **PRD wins** or **ADR wins** where they occur below. Nothing in this file is invented; if you need something that is not here, propose it in the change's `design.md` with a reference, do not improvise it in code.

## 1. Purpose and the one rule in UI

**Nothing reaches a human that the human's rules do not allow, and nothing leaves a principal that the principal did not approve.** The human's attention is the scarce resource; the agent's convenience never wins a tie. In UI this means:

- The participant can decline from the email, in one tap, without opening anything. Every request screen is skimmable in seconds; the email is "thin on purpose".
- The principal always sees the exact wording before it leaves, and the cost is on the button. No hidden step sends anything.
- Asymmetric cost: asking costs the agent (money, budget, reputation); answering or ignoring is nearly free for the human. Never add friction on the participant side to save work on the agent side.
- Humans are a last resort for agents. Platform copy says so.

## 2. Design tokens

Three tiers live in `packages/ui/tokens`. Apps, Storybook stories, the MCP App card and email templates consume semantic or component tokens as `var(--token)` (and a typed TS map); **no hex or OKLCH value is written outside `packages/ui/tokens`**. The exact ladder values, the accent hue (teal is the default candidate; it must read on Claude's warm paper and not collide with the host's own accent), the status hues and the one optional web typeface are settled in the `m2-design-foundations` change, inside the rules below. Until that change lands, `design.md` names roles, never values.

### 2.1 Tiers

- **Primitives**: OKLCH scales on a lightness ladder, one for the neutral, one for the accent, one per status hue. Each ladder carries a step contract documenting which step is text-safe on which background (in the manner of Radix Colors and USWDS grades). Primitives never leave `packages/ui`; no component, app or email references one.
- **Semantic roles**, the only tier design.md and apps talk about:

| Role | Use |
|---|---|
| `--surface` | page, card, screen and bottom-bar background |
| `--surface-2` | inputs, quote blocks, skeletons, neutral pills, secondary panels |
| `--text` | all text, including every human word |
| `--text-muted` | secondary text, labels, eyebrows, right-aligned values |
| `--border` | dividers and card edges; alpha, so it sits on any host surface |
| `--border-strong` | input and control boundaries, 3:1 against the surface; alpha |
| `--accent` | the platform: primary buttons, links, selected and "on" states, progress, current step, agent-draft marker, platform notes |
| `--on-accent` | text on solid accent |
| `--success-bg` / `-border` / `-text`, `--pending-*`, `--danger-*`, `--neutral-*` | status triplets, see §3.2 |
| `--focus` | focus ring, 3:1 against adjacent colours on every surface |

`human` is a role name used in specs, not a token: it resolves to `--text` on `--surface` and nothing else (§3).
- **Component tokens** (`--button-primary-bg`, `--pill-pending-bg`, …) are defined in each component's CSS module from semantic roles only.

### 2.2 One neutral, tilted warm

A single grey family for every surface (PWA, dashboard, email), derived in OKLCH with a slight warm bias. Reference points, not copied values: the paper of the Claude host (`#FAF9F5` / `#F5F4ED` light, `#141413` / `#262624` dark). The prototypes' two palettes (cool slate for principals, warm paper for participants) are retired. Borders and dividers are alpha.

### 2.3 Dark theme

Derived from the same ladder, never hand-picked. Selectors: `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {...} }` plus `:root[data-theme="dark"] {...}` for an explicit override; set `color-scheme: dark` in both. Email is light-only (§8).

### 2.4 Contrast rules

Tested in CI on every semantic pair, blocking on WCAG 2.2: text 4.5:1, large text, control boundaries and the focus indicator 3:1. APCA is reported, not blocking (targets Lc 75 body, Lc 60 secondary). Status text on its own status background must pass 4.5:1 in both themes; a pair that fails is fixed on the ladder, never with a one-off value. Verify in the Storybook a11y addon before review.

### 2.5 Typography

- **System font stack** on the request page, the answer form, the MCP App card and email (2 s on 3G, hosts forbid custom fonts). At most **one web typeface**, under about 60 KB, as a progressive enhancement on the dashboard and the participant home. No display serif.
- One modular scale on a 4 pt baseline: steps are named tokens (`--text-xs … --text-3xl`), line-heights are multiples of 4; body 1.5; headings `text-wrap: balance`; measure 60–62ch.
- **Money in tabular numerals with its verb** (`font-variant-numeric: tabular-nums`: held, cleared, returned, paid out); request ids and signatures in the **mono role** at 12–13 px. Big numbers (cleared amount, home tiles) are the largest scale step in tabular figures, not a display face.
- Status pills, eyebrows and table headers in sentence case; the prototypes' uppercase tracking is not carried over.

### 2.6 Spacing, radius, motion

- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Page gutter 16 (`max(16px, env(safe-area-inset-*))`), 16 between stacked blocks, 8 between buttons and tiles, 4–8 between chips.
- Radius scale: 4 (small chips, checkboxes), 8 (buttons, inputs, segments, anything inside the MCP App card), 12 (cards, screens, quote blocks), pill (999px).
- Motion tokens: `--motion-fast`, `--motion-base` durations and one easing. **Reduced motion is the default stylesheet**; transitions and animations are added only under `@media (prefers-reduced-motion: no-preference)`.

### 2.7 Guest subset for the MCP App card

The card is a guest in a host iframe (Claude, ChatGPT, other MCP App hosts) and a second build target of `packages/ui`. It consumes the host's `styles.variables` from the MCP Apps `HostContext` (background, text, border, ring, font, radius) for all structure, mapped by a host-variable adapter onto `--surface`, `--text`, `--border`, `--focus`; it adds only the A2H `--accent` on the primary button and one badge, plus the status triplets. **No own background, no own font, radius at most 8, at most two actions, at most five data points, and the text fallback is written first** (it is also what terminals show). Zero global CSS. Precedents: MCP Apps `HostContext` and Stripe's Appearance API.

## 3. Colour convention: human plain, machine coloured

**A human's words are the most typographically neutral element on any screen: `--text` on `--surface`, generous measure, no tint, no coloured border, no badge inside the text block. The platform accent carries every machine or platform element and every interactive control, on every surface. One accent, no second hue.** Replaces the prototypes' "teal = agent, ochre = human" and the ochre-tinted human card (**ADR wins**, 0003 Decision 3).

Human words are the answer text, the voice transcript, the typed answer, the published profile paragraph and anything else a participant wrote. Who wrote them is stated in words, never in colour: the eyebrow "Answer from a human" and the attestation line in the mono role beneath the answer (answered personally · confidence · timestamp · signature). Machine text (the question as the agent drafted it, platform notes, status chrome) and every control take `--accent`. There is no separate participant-action hue: a participant's primary button is the same accent as a principal's; the label and the surface say who is acting.

### 3.1 What takes the accent, per surface

| Surface | Takes `--accent` | Stays plain (`--text` on `--surface`) |
|---|---|---|
| Participant PWA | primary buttons, links and back links, chip/segment/confidence/star "on" states, toggles on, progress bar, current step, record control and waveform, `pill.accent` (request type), `card.platform` notes, focus | the question quote block's text, the transcript, the typed answer, the profile paragraph, kv values |
| Principal dashboard | primary buttons, links, chip "on" in the contact policy, tool-trace markers, current step, the "Agent draft / Restore agent draft" marker, `pill.accent` ("verified profiles", "MCP"), focus | the human answer block, kv values, ledger cells |
| MCP App card | the primary button and one badge | everything else, from host variables; the editable question sits on the host surface |
| Terminal | box frame and the primary-action marker, when colour is supported; text first | the question, the answer, every line of copy |
| Email | one primary button, link colour | all body text; no human words appear (summary only) |

Legend for Storybook docs: "Platform and controls" swatch accent; "A person's words" swatch is plain text, no swatch.

### 3.2 Status

Status is separate from origin and is a **background / border / text triplet** per role: `success` (answered, paid, in flight), `pending` (not sent, pending, new, campaign progress, identity not yet verified), `danger` (disputed, blocked, errors), `neutral` (free lane, expiry, required). Sentence case, light background, dark text, **always with words**; at most four hues plus neutral for the six request states; **pending leaves the amber family** so it cannot be read as a warmth marker. Colour is never the only signal: a pill without text, a border without a label or an "on" state without `aria-checked`/`aria-pressed` is a defect.

## 4. Core patterns

Each pattern lists structure, states and copy. design.md references these by letter and only documents deviations. Money: principals see **gross** figures with their verb (held, cleared, returned); participants see **net** figures as "you receive €N"; both sides can open the breakdown "includes A2H fee f%" (ADR 0002 D4). `f` is configuration; copy carries "f%" until the pre-M4 ADR fixes it, and figures are formatted at the edge.

### 4a. Request card (principal, MCP App or host-rendered)

Structure, top to bottom:
- eyebrow "A2H · approve before sending" + `pill.pending` "not sent";
- h4 recipient handle, role, latency ("Marieke V. · Diabetes nurse educator · ~6h");
- label "Your question, sent as written"; **the question is the body of the card, an always-editable textarea** (`--surface-2`; host surface inside the card);
- meta line: left "Agent draft" in `--accent`, replaced by a link "Restore agent draft" once the text differs; right "N / 2000 · 1 attachment";
- `<details>` whose summary is the collapsed line "Bid €30 · yes/no + short text + confidence · expires in 24h · stored privately", opening to a kv list: Bid ("€30, held now. You pay what clears, never more. Her reserve is €R. Prices include the A2H fee (f%), breakdown in the terms."), Answer format, Effort for her, Expires ("… · unanswered means nothing charged"), Data terms;
- button row: primary **"Send · hold €30"**, ghost "Don't send". Two actions, never more (§2.7).

States:
- typing is editing, there is no edit mode to enter or leave;
- primary disabled when the question is empty or whitespace;
- identity is never re-asked, it was set once in the contact policy;
- after send the card becomes "Request sent" with `pill.success` "A2H-7f3c · in flight" and kv To / Held ("€30, your bid (€164 left this month). You pay what clears, never more.") / Expected / You'll be told by.
- **PRD wins:** the To line reads "delivered to her inbox"; drop "and her own agent", there is no participant-side agent in v1.

Protocol: form-mode elicitation, one pre-filled string plus accept/decline; rendered as an MCP App where the host can, text result elsewhere.

### 4b. Terminal rendering of the same card

A box drawn in `--accent` where colour exists, titled "A2H wants to send a question to Marieke V."; line "From: Galem L., Automi · Bid €30 (held) · expires in 24h"; "Question (edit before sending):" followed by the question as plain text; actions `❯ Send · hold €30`, `Edit in $EDITOR`, `Don't send`. Same order, same consequence on the primary action, same single approval. Confirmation line: "Sent (A2H-7f3c). You'll get an email when she answers; run /a2h or just ask me to check."

### 4c. Human answer card / turn (principal)

A first-class turn, `human-card`, with **no tinted background and no coloured border** (**ADR wins**): `--surface`, `--border`, same radius as every card.
- eyebrow in `--text-muted` "Answer from a human · A2H-7f3c";
- h4 name and role;
- **the answer text as a plain text block** in `--text`, body size, 60ch measure; voice note player above the transcript when audio exists, the principal receives both;
- **attestation line in the mono role beneath the answer**: "answered personally · confidence 4 / 5 · Wed 21 Oct 09:10 · a2h:sig:…c91e", plus `pill.pending` "identity not yet verified" when the answer is from a not-yet-verified participant (CLAUDE.md, PRD §7.5);
- kv: verdict row labelled with the question's short form ("Alarming? Yes"), Answered ("16h after sending"), Cleared at ("€28 cleared · €2 of the €30 hold returned · includes A2H fee f%", breakdown link), Citable as ("reviewed by M.V., 21 Oct 2026");
- actions: primary "Ask a follow-up (€10)" in `--accent`, ghost "Rate", ghost "Dispute". The accent appears only on the follow-up button and the status badge.
- **PRD wins:** attestation is always "answered personally"; there is no "via her agent" variant.

Waiting state, before the answer: one `notice` with `pill.pending` "1 request pending" and "Marieke V. accepted at 17:05 and has it open. Nothing is charged until she answers." plus an "All requests" link. Visible, never nagging; the conversation continues normally around it.

### 4d. Participant request email (packages/email)

Subject: "A short review, up to €N for you, about leaflet wording" (type, net money, topic). Body: from line; one sentence "**Galem L.**, product manager at **Automi** (verified), asks whether …" (asker and verification, paraphrased topic); kv Effort / You receive ("up to €N · never less than your €25 reserve · A2H fee f% already taken out") / By (deadline) / Also sent to ("You first. If you decline, 2 others."); muted line "Within your rules: short review · 1 of 2 today · verified organisation."; one primary button "Open the question"; ghost "Decline" link that works from the inbox and carries an optional reason. **Never the question text, never an attachment.**

### 4e. Request page (PWA)

Structure:
- app bar "Request · A2H-7f3c" with back; `pill.accent` "Short review · up to €N" and `pill.neutral` "expires in 24h";
- h2 "From Galem L., Automi" (the accountable principal, as the policy shows them);
- the question **verbatim** as a quote block on `--surface-2` with an `--accent` eyebrow "Their question", exactly as the principal approved it;
- attachment card ("when_to_call.pdf · 140 words · opens here"), opened in the PWA, never downloaded silently;
- kv Format / Your answer (data terms: "Stored in their workspace · not published · not used for training") / You receive;
- bottom bar: primary "Accept and answer", ghost "Decline". No counter-offer, no price field.

Money line (**ADR 0002 wins** over the prototype's "at least your €25 reserve"): You receive ("€N if it clears at their bid, never less than your €25 reserve. Nothing changes hands if it expires."), followed by the one-line breakdown in `--text-muted`: "Their bid is €30 · includes A2H fee f% · you receive up to €N". Net to the participant, gross to the principal, both sides can see both.

Behaviour: accepting starts the timer the principal sees ("accepted at 16:44, has it open") and locks the hold. First paid request only, the "One check before your first paid answer" screen follows: ID via Stripe Identity (2 min), IBAN via Stripe (1 min), "Your request stays accepted and the hold is kept while you do this.", primary "Verify with Stripe", ghost "Answer first, verify before payout". Free lanes never see it; the PWA never handles documents or bank details.

### 4f. Answer form (PWA)

Fields in order, per the type's answer schema from `packages/protocol`:
1. verdict as a segmented control (React Aria radio group), the question's short form as its label ("Would a new patient find it alarming?"), options "Yes / No / Can't tell"; **"Can't tell" is first-class: same size, same position every time, never penalised**;
2. "How sure are you?" confidence 1–5 as five equal tap targets, tabular digits;
3. the free part, labelled with the follow-on question: voice recorder (record control in `--accent`, waveform, duration) **with the transcript shown under it, plain text, for correction** ("Edit transcript" link), and a ghost "Type instead" that swaps to a plain textarea. The participant's words carry no tint, no accent border;
4. attestation row "I answered this myself" with `pill.neutral` "required", a checkbox the user must tick; it becomes part of the signature.
Bottom bar: primary **"Send answer · at least €25 to you"**.

States: send disabled until verdict and attestation are set; recording and transcribing states on the recorder; transcription failure leaves the audio in place and offers typing; a draft survives a reload. **No model is ever called on this form, for drafting, suggestion or correction.**

Sent screen:
- what you receive as the largest tabular number ("€N"), lead "Cleared at the auction price. You receive €N; the A2H fee (f%) is already taken out. Paid out Friday 24 Oct with your other answers."; ghost "Show breakdown" opens "Cleared at €28 · fee f% · you receive €N";
- kv Request ("A2H-7f3c · answered in 7 min") / Signature (mono) / Your answer ("Can be cited by them as 'reviewed by M.V., 20 Oct 2026'");
- rating card "How was this request?" with five stars (34px visual in a 44px target) and "Clear question, fair offer, respected your rules. Only A2H sees this.";
- line "They may ask one follow-up on this thread (€10). You can decline it."; primary "Done".

### 4g. Onboarding (five screens, plus the invitation)

Every screen: app bar with "n of 5" in the mono role, an `--accent` progress bar with `aria-current="step"`, one h2, one `p.lead`, at most one primary and one ghost action in the bottom bar.
0. Invitation email: "Sanne K. thinks you could answer questions like this"; referrer's real numbers ("6 questions in about 4 minutes each, €19 to €35 received"); an "Example of what arrives" card with a real question, asker type, net price and effort; "You decide what you answer, at what price, and how often you're asked. Nothing reaches you until you've set that."; primary "See how it works · 1 min", ghost "Not for me". *Principle: show the thing before the form.*
1. Email: "Where should questions reach you?"; one field; "No app to install, no password."; work-domain hint ("can be used to confirm where you work, if you want"); primary "Send me a sign-in link". Magic link only.
2. Import: "Tell us what you know, the fast way"; LinkedIn and X rows with "Connect"; `card.platform` "**We read, we don't write.** Read-only access, used once to draft your topics. We never post, follow, or message for you. Disconnect any time."; primary "Connect LinkedIn", ghost "I'll type my topics instead" (equally first-class). *Principle: ask permission for exactly one thing, explain it, name what you will never do.*
3. Topics: "Does this look right?"; one screen of chips, each with its evidence label in small ("✓ job title", "✓ 3 posts"); "+ Add a topic"; card "Shown to agents as" with handle and `pill.accent` attestations and "Your name is shown only after you accept a request."; primary "Looks right". *Import, then edit; no more than one screen of chips.*
4. Rules: "Your rules"; "Agents must follow these. Out-of-scope requests are blocked before they reach you."; rows per request type with the **net reserve** ("you receive at least €25", tabular, right) and toggle; second card: free lane toggle, "I usually answer within", "At most n / day", "Quiet hours", "Who may ask"; primary "Save my rules". **PRD wins (§4):** no "Live calls" row; live calls are out of v1.
5. Published: "You're reachable"; the whole profile as **one plain-language paragraph, plain text in `--text` on `--surface`**, no quote styling, no tint (these are the participant's words); one "Pause everything" switch; `card.platform` "Paid answers need a one-time identity check (2 min, through Stripe) and a payout account. We'll ask when your first paid request arrives, not now."; primary "Done", ghost "Share my A2H page". *Onboarding ends at the first moment of value; verification and payout are deferred.*

### 4h. Participant home (PWA)

Four tiles (tabular numbers, net amounts): paid out today, answered this month, median time to answer, "declined · N out of scope blocked" (the spam defence made visible). Request list: pending first, sorted by expiry, each row status pill + type + asker or panel + right-aligned tabular value (deadline or net amount); then paid, free. `card.platform` demand panel: "N requests for 'topic' this month went to others at €25–40 (to them). You receive at least €25 for this type. Review your rules" — prices as a range, never per-request bids. Bottom ghost "Profile & rules · Pause". Every row is reachable from an email link; the PWA is installable, never required.

### 4i. Principal contact policy and ledger

Policy, set once (`a2h.dev › Your contact policy`, h3 "How your agents may reach people"): a label/value grid (150px label column, stacks under 600px) with chip groups in the `--accent` "on" state:
- Shown to humans as: real name · verified organisation only · verified person, pseudonymous;
- Monthly budget and per-request max, tabular inputs (gross);
- Ask me before: any expert request · anything over €X · any campaign to many people · every single request;
- Auto-approve: sensor polls under €Y · free lanes;
- Wording review: "Always show me the exact question" (default) · only when asked to approve;
- Answers reach me by: email (the only channel in v1);
- Data terms I offer: stored in my workspace · attributed publicly · may be used for training;
- Wallet: "€ 200 · Visa ···· 4421 · funded through Stripe, opened in your browser" (URL-mode elicitation, card details never pass through the client);
- one primary "Save policy". Everything decided here is what makes the per-request moment two actions instead of a form.

Ledger (`a2h.dev › Requests`):
- stats row: requests this month, spent of budget (gross), median answer time, pending;
- table in a horizontal-scroll wrapper, mono headers Id · To · From agent / thread · Status · Cleared · Answered;
- status as pills (answered, "54 / 60" for campaigns, free lane, disputed); numeric cells tabular with `white-space: nowrap`; disputes show "€40 → refunded"; cleared amounts are gross with the fee breakdown one click away;
- one ledger for every agent and every client; this is where campaigns are watched, disputes raised and the budget reconciled.

### 4j. Notification email to the principal

Subject "Marieke V. answered your request". Body: "Your request `A2H-7f3c` about the Glucomate leaflet wording has an answer. Marieke V. answered personally, confidence 4/5, cleared at €28." (add "identity not yet verified" when applicable); "Open the thread **Glucomate patient leaflet** and your agent will pick the answer up and continue from it."; primary "Open the thread" (deep link to the originating thread, request id in the link, no PII in the URL), secondary "View answer here"; footer "You received this because A2H requests from your agents notify you by email. Change channel · Stop all A2H requests". One email per answer, nothing before.

## 5. States every screen specifies in design.md

For each screen, design.md names the copy and layout of:
- **empty**: what the first-time view says and what it invites (home before the first request, ledger before the first send);
- **loading**: skeleton blocks in `--surface-2`, no spinner-only screens;
- **error**: a `danger` triplet notice stating what happened and what to do, with a retry;
- **offline**: the PWA shows cached content and says sends will retry; the answer form keeps its draft locally;
- **expired**: "This request expired on … · nothing was charged"; the hold is released;
- **declined**: by the participant, reason optional; shown to the principal as a status, never as a name before acceptance;
- **blocked**: the manifest failed the participant's rules; counted on the participant's home ("1 out of scope blocked"), shown to the principal as a reason without the participant's identity.
Email templates additionally specify the plain-text fallback and image-less rendering; the MCP App card specifies its text fallback first.

## 6. Copy rules

- Plain language, second person, no jargon from the protocol ("manifest", "elicitation") in participant copy.
- Buttons state the consequence: "Send · hold €30", "Send answer · at least €25 to you", "Accept and answer", "Connect and set my contact policy". "Don't send", "Decline", "Not for me" are the no-pressure alternatives.
- Money is always "€N" with what happens to it: held, cleared, returned, paid out Friday, nothing charged. **Principals read gross, participants read net ("you receive €N"), and "includes A2H fee f%" with both figures is one tap away on both sides; nothing is hidden from either.** The principal's worst case is the number on the button. Minor-unit integers are formatted at the edge, never computed in the UI.
- Competition without anxiety: "You first. If you decline, 2 others." Never a countdown race, never other people's bids.
- Names are withheld until acceptance: agents see handles and attested facts; the email names the asker (accountable principal), never the participant to the principal before acceptance.
- "Can't tell" is a full answer; copy never frames it as a failure.
- The platform shows its work: "Within your rules: …", "1 out of scope blocked", "Only A2H sees this".
- State the one thing never done next to every permission ("We never post, follow, or message for you").
- Who wrote something is said in words ("Answer from a human", "Agent draft", "Their question"), never only in colour.

## 7. Accessibility (WCAG 2.2 AA)

- Keyboard-complete: every action reachable by Tab; segments and confidence are React Aria radio groups with arrow keys; `<details>` for the collapsed line; React Aria Components or native `<button>`/`<input>`/`<textarea>` for every control, never a clickable `<div>`.
- Focus: `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }` on every surface, never removed; inside the MCP App card the host's ring variable maps to `--focus`.
- PWA targets at least 44×44px: primary buttons, segments, confidence, stars (34px visual inside a 44px hit area), toggles, chips. Dashboard: 32px targets with 8px spacing.
- Reduced motion is the default stylesheet (§2.6); the waveform animates only when recording and only under `prefers-reduced-motion: no-preference`.
- Colour is never the only signal: every status pill carries text; the human answer carries the eyebrow and the attestation line, not a border colour; chip "on" also sets `aria-pressed`/`aria-checked`.
- Every field has a visible `<label for>`; counts and hints via `aria-describedby`; the required attestation is announced as required.
- Steps and rails use `aria-current="step"`; navigation regions carry `aria-label`.
- Contrast: CI blocks on the WCAG pairs in §2.4 for both themes; any new pair introduced by a change is listed in design.md with its measured ratio and checked in the Storybook a11y addon. APCA Lc is reported alongside, not enforced.
- Dark mode via `prefers-color-scheme` with `data-theme` override; both are tested.
- Language and direction set on `<html>` (React Aria handles RTL); voice notes always have a transcript.

## 8. Components, performance and PWA

- Component base: **React Aria Components**, wrapped in `packages/ui` as our own source (upstream dependency, not copy-in), styled with **CSS modules and semantic tokens**. Nothing in `apps/*` styles a control directly; a missing component is a request to Design. **Storybook is the design source of truth** until a Figma library exists; every component ships its stories, both themes, every state.
- The MCP App card is a second build target of `packages/ui` with zero global CSS (§2.7); `apps/mcp` serves the built bundle as the `ui://` resource.
- The request page loads under 2 s on 3G: server-rendered, system fonts, no client JS required to read the question or decline, attachments lazy. The optional web face loads with `display=swap`, subset, only on the dashboard and participant home.
- Installable (manifest, icons, offline shell) but never required; every email link opens the PWA in the browser and deep-links to the request.
- Safe areas: page gutters `max(16px, env(safe-area-inset-left/right))`; bottom bar `padding-bottom: calc(16px + env(safe-area-inset-bottom))`; sticky bottom bar on `--surface` with a `--border` top edge.
- Phone frame reference width is 390px; nothing scrolls horizontally except the ledger table wrapper.
- Email templates: React Email, table layout, **semantic tokens inlined at build time from `packages/ui`, no web font, light-only sRGB**, alpha borders replaced by their solid fallbacks at build.

## 9. Design review on a preview

1. Open the PR's preview stage (and the Storybook stage for `packages/ui` changes) with the Playwright MCP.
2. Screenshot every screen in the change at **390px** and **1280px**, in **light and dark** (`prefers-color-scheme` emulation and `data-theme`), and with **reduced motion** on; attach them to the PR.
3. Keyboard-only pass: Tab through each screen, confirm order, visible focus, that the primary action is reachable and that Escape/back works.
4. Checklist, each item answered in the review comment:
   - tokens only: no hex or OKLCH in `apps/`, `packages/email` or the card bundle; no primitive referenced outside `packages/ui/tokens`;
   - role model matches §3: no tint, border colour or badge on a human's words; one accent; status as triplets with words; pending not amber;
   - copy matches §4 and §6; buttons state consequences; money lines complete and on the right side of gross/net with the breakdown reachable;
   - every state in §5 exists and was screenshotted;
   - §7 items, including contrast of any new pair, 44px targets on the PWA, 32px on the dashboard;
   - request page timing under 2 s on throttled 3G in the Playwright trace; system fonts on request page, answer form, card and email;
   - MCP App card: host variables only for structure, ≤ 2 actions, ≤ 5 data points, radius ≤ 8, text fallback present;
   - email: no question text, summary fields present, decline link works from the rendered email, no web font.
5. Say what was tested and what was not. Block on any §10 item.

## 10. Never

- Never call a model in the answer form, or anywhere on the participant side.
- Never put the question text or an attachment in an email.
- Never show a bidding war: no per-request bids of others, no live counters, no countdown race.
- Never tint a human's words: no background, border colour or badge on answer text, transcript or profile paragraph.
- Never add a second accent hue; the platform accent is the only hue besides status.
- Never ship global CSS into the MCP App card, and never give it its own background.
- Never use a custom font in the card or in email.
- Never invent a hex or OKLCH value outside `packages/ui` primitives; never ship a component outside `packages/ui`.
- Never show a participant a gross figure as "theirs", or a principal a net figure as the price; never hide the fee breakdown from either side.
- Never add counter-offers, price negotiation or a "propose a price" field.
- Never add a "Live calls" lane or any synchronous format in v1.
- Never show a participant's name before acceptance, or identity before the principal's policy allows it.
- Never nag: one email on answer, one pending chip, nothing before.
