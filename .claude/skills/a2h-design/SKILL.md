---
name: a2h-design
description: Load when building or reviewing any A2H UI (participant PWA, principal dashboard, MCP App card, terminal rendering), any email template in packages/email, or a change's design.md; it fixes tokens, the teal/ochre convention, core patterns, copy, states, accessibility and the Playwright review.
---

# A2H design skill

Sources of truth, in order: `docs/PRD.md` (§6, §7, §8, §11), `CLAUDE.md` (the one rule, engineering rules), then the click-through prototypes `docs/prototypes/principal.html` and `docs/prototypes/participant.html`. Where a prototype and the PRD disagree, the PRD wins; the known cases (live calls, platform fee, participant-side agent) are marked **PRD wins** where they occur below. Nothing in this file is invented; if you need something that is not here, propose it in the change's `design.md` with a reference, do not improvise it in code.

## 1. Purpose and the one rule in UI

**Nothing reaches a human that the human's rules do not allow, and nothing leaves a principal that the principal did not approve.** The human's attention is the scarce resource; the agent's convenience never wins a tie. In UI this means:

- The participant can decline from the email, in one tap, without opening anything. Every request screen is skimmable in seconds; the email is "thin on purpose".
- The principal always sees the exact wording before it leaves, and the cost is on the button. No hidden step sends anything.
- Asymmetric cost: asking costs the agent (money, budget, reputation); answering or ignoring is nearly free for the human. Never add friction on the participant side to save work on the agent side.
- Humans are a last resort for agents. Platform copy says so.

## 2. Design tokens

`packages/ui` exports every token below as CSS custom properties (and a typed TS map). Components, apps, Storybook stories and email templates consume `var(--token)`; **no hex value is hardcoded outside `packages/ui/tokens`**. Two neutral palettes exist on purpose: cool slate for the principal/chat surface, warm paper for the participant PWA. Accent (teal), human (ochre) and status hues are shared.

Dark mode: `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {...} }` plus `:root[data-theme="dark"] {...}` for an explicit override; set `color-scheme: dark` in both.

### 2.1 Principal / chat surface (cool slate)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f3f4f6` | `#10151b` | page background |
| `--paper` | `#ffffff` | `#171d25` | cards, screens, read-only textarea |
| `--fg` | `#17202b` | `#e6eaef` | text |
| `--muted` | `#5d6b7a` | `#97a3b0` | secondary text, eyebrows, labels |
| `--line` | `#d8dde4` | `#2b353f` | borders, dividers |
| `--sidebar` | `#e9ecf0` | `#131920` | title bars, thread lists |
| `--chip` | `#eef1f4` | `#222b35` | user bubbles, editable textarea, neutral pills |
| `--accent` | `#0f6f73` | `#4fb8bb` | agent/platform: primary buttons, links, focus ring |
| `--accent-ink` | `#ffffff` | `#06282a` | text on solid accent |
| `--accent-soft` | `#dcefef` | `#16363a` | accent pill background, chip "on" (principal side) |
| `--human` | `#a85e12` | `#e0a35c` | human-origin border, legend swatch |
| `--human-soft` | `#fbead6` | `#3a2a15` | human-card background, avatar background |
| `--human-deep` | `#5a3106` | `#f7d9b3` | ochre text on `--human-soft` (prototype calls this `--human-ink`; see note) |
| `--pend` / `--pend-soft` | `#b7791f` / `#fdf1d5` | `#e0b25a` / `#3a2f16` | pending, not sent, in progress |
| `--ok` / `--ok-soft` | `#2f7a3d` / `#dff2e1` | `#6cc77c` / `#163a1d` | answered, paid, in flight |
| `--warn` / `--warn-soft` | `#9c2f2f` / `#f8dede` | `#e07a7a` / `#3f1d1d` | disputed, errors, open questions |

### 2.2 Participant PWA (warm paper)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f5f3ef` | `#171411` | page background |
| `--paper` | `#ffffff` | `#201c18` | screen, cards, bottom bar, segment buttons |
| `--fg` | `#1d1a16` | `#eee8df` | text |
| `--muted` | `#6a6259` | `#a49a8e` | secondary text, labels, right-aligned values |
| `--line` | `#dcd6cd` | `#36302a` | borders, toggles off, progress track |
| `--rail` | `#ebe6de` | `#1c1815` | rails, secondary surfaces |
| `--chip` | `#f0ece5` | `#2a2521` | inputs, quote blocks, audio recorder, neutral pills |
| `--accent` | `#0f6f73` | `#4fb8bb` | platform/agent: teal cards, accent pills, back links, focus ring |
| `--accent-soft` | `#dcefef` | `#16363a` | `card.teal` background, accent pill background |
| `--human` | `#a85e12` | `#e0a35c` | participant action: primary button, toggles on, progress, mic, waveform, chip/seg borders |
| `--human-ink` | `#ffffff` | `#2a1706` | text on solid ochre (primary button, mic) |
| `--human-soft` | `#fbead6` | `#3a2a15` | chip/segment/confidence/star "on" background, human pill |
| `--human-deep` | `#5a3106` | `#f7d9b3` | ochre text on `--human-soft` |
| `--pend`, `--ok`, `--warn` (+`-soft`) | as 2.1 | as 2.1 | status pills |

Naming note: the principal prototype's `--human-ink` (`#5a3106`) is the participant prototype's `--human-deep`. `packages/ui` uses the participant naming on both surfaces: `human-ink` = text on solid ochre, `human-deep` = ochre text on soft ochre.

### 2.3 Typography

| Role | Family | Weights | Sizes used |
|---|---|---|---|
| `--display` | Newsreader (serif, opsz 6..72) | 400, 500, italic 400 | 40/1 (cleared amount), 34/1.1 (page h1), 24/1.15 (PWA screen h2), 22/1.2 (dashboard h3), 22/1.1 (stat and tile numbers), 16/1.45 (human answer quote), 15/1.5 (question quote on PWA) |
| `--body` | Public Sans | 400, 500, 600, 700, italic 400 | 15 (PWA inputs, buttons, body), 14 (chat, cards, rows), 13 (secondary, kv, small buttons), 12 (meta, footers) |
| `--mono` | JetBrains Mono | 400, 500 | 11 uppercase `.08em` (eyebrow), 11 `.04em` (pill), 11 uppercase `.06em` (table th), 12 (tool traces, status bar, right-aligned values), 12.5 (terminal), 14 (confidence buttons) |

Rules: body line-height 1.5; headings `text-wrap: balance`; money, ids, counts and dates in `--mono` with `font-variant-numeric: tabular-nums`; display face is for headings, quoted question/answer text and big numbers only, never for UI controls; fallbacks `Georgia, serif` / `system-ui, sans-serif` / `ui-monospace, Menlo, monospace`.

### 2.4 Radii and spacing

- Principal surface: card 10px, button/input/textarea 8px, screen frame 12px, chat bubble `14px 14px 4px 14px`, pill 999px.
- PWA: card 14px, button 12px (small 9px), input/segment/confidence 10px, quote/audio/tile/ident 12px, chip 999px, star 9px.
- Spacing: 16px page gutter (`max(16px, env(safe-area-inset-*))`), 14px between stacked blocks, 8px between buttons and tiles, 6px between chips and segments, card padding `14px 16px` (principal) and `14px` (PWA), text measure 60–62ch, chat message max 62ch.
- Status pill text and eyebrows are uppercase mono; nothing else is uppercase.

## 3. Colour convention: teal and ochre

**Teal (`--accent`) = it came from the agent or the platform. Ochre (`--human`) = it came from a human, or it is the participant's own action.** This is never inverted, on either surface, in any state.

| Element | Colour |
|---|---|
| Principal: primary buttons, links, tool-trace arrows, current step marker, chip "on" state in contact policy, `pill.accent` ("verified profiles", "MCP") | teal |
| Principal: `human-card` (answer turn: `--human` border, `--human-soft` background, eyebrow and kv labels in `--human-deep`), avatar circles in expert lists, `pill.human` ("attested · answered personally") | ochre |
| Participant: primary buttons (`--human` with `--human-ink` text), chip/segment/confidence/star "on" state, toggles on, progress bar, current step marker, mic button, waveform, transcript border, `pill.human` ("required") | ochre |
| Participant: `card.teal` (platform statements: "We read, we don't write", verification deferred, demand panel), `pill.accent` (request type and price, "employer confirmed"), back links, links | teal |
| Legend (prototypes, Storybook docs): "Agent / platform" swatch teal, "Came from a human" / "your own action" swatch ochre | fixed |

Status hues are separate from origin: `pill.ok` answered/paid/in flight, `pill.pend` not sent/pending/new/campaign progress, `pill.warn` disputed/blocked, neutral `pill` free lane/expiry.

## 4. Core patterns

Each pattern lists structure, states and copy. design.md references these by letter and only documents deviations.

### 4a. Request card (principal, MCP App or host-rendered)

Structure, top to bottom:
- eyebrow "A2H · approve before sending" + `pill.pend` "not sent";
- h4 recipient handle, role, latency ("Marieke V. · Diabetes nurse educator · ~6h");
- label "Your question, sent as written"; **the question is the body of the card, an always-editable textarea** (`--chip` background; `--paper` when read-only);
- meta line: left "Agent draft", replaced by a link "Restore agent draft" once the text differs; right "N / 2000 · 1 attachment";
- `<details>` whose summary is the collapsed line "Bid €30 · yes/no + short text + confidence · expires in 24h · stored privately", opening to a kv list: Bid ("€30, held now. You pay what clears, never more. Her reserve is €25."), Answer format, Effort for her, Expires ("… · unanswered means nothing charged"), Data terms;
- button row: primary **"Send · hold €N"**, ghost "Don't send".

States:
- typing is editing, there is no edit mode to enter or leave;
- primary disabled when the question is empty or whitespace;
- identity is never re-asked, it was set once in the contact policy;
- after send the card becomes "Request sent" with `pill.ok` "A2H-7f3c · in flight" and kv To / Held ("€30, your bid (€164 left this month). You pay what clears, never more.") / Expected / You'll be told by.
- **PRD wins:** the To line reads "delivered to her inbox"; drop "and her own agent", there is no participant-side agent in v1.

Protocol: form-mode elicitation, one pre-filled string plus accept/decline; rendered as an MCP App where the host can, text result elsewhere.

### 4b. Terminal rendering of the same card

A box drawn in `--accent` with the title "A2H wants to send a question to Marieke V."; line "From: Galem L., Automi · Bid €30 (held) · expires in 24h"; "Question (edit before sending):" followed by the question on a `--chip` background; actions `❯ Send · hold €30`, `Edit in $EDITOR`, `Don't send`. Same order, same consequence on the primary action, same single approval. Confirmation line: "Sent (A2H-7f3c). You'll get an email when she answers; run /a2h or just ask me to check."

### 4c. Human answer card / turn (principal)

A first-class turn in its own colour, `human-card`:
- eyebrow in `--human-deep` "Answer from a human · A2H-7f3c"; `pill.human` "attested · answered personally";
- h4 name and role;
- the answer text as a display-face quote (16/1.45); voice note player above the transcript when audio exists, the principal receives both;
- kv: verdict row labelled with the question's short form ("Alarming? Yes · confidence 4 / 5"), Answered ("Wed 21 Oct 09:10 · 16h after sending"), Cleared at ("€28 · €2 of the €30 hold returned"), Signature (mono `a2h:sig:…c91e` · citable as "reviewed by M.V., 21 Oct 2026");
- actions: "Ask a follow-up (€10)", ghost "Rate", ghost "Dispute";
- `pill.pend` "identity not yet verified" when the answer is from a not-yet-verified participant (CLAUDE.md, PRD §7.5).
- **PRD wins:** attestation is always "answered personally"; there is no "via her agent" variant.

Waiting state, before the answer: one `notice` with `pill.pend` "1 request pending" and "Marieke V. accepted at 17:05 and has it open. Nothing is charged until she answers." plus an "All requests" link. Visible, never nagging; the conversation continues normally around it.

### 4d. Participant request email (packages/email)

Subject: "A short review, €30, about leaflet wording" (type, money, topic). Body: from line; one sentence "**Galem L.**, product manager at **Automi** (verified), asks whether …" (asker and verification, paraphrased topic); kv Effort / Offer ("€30 · your reserve is €25") / By (deadline) / Also sent to ("You first. If you decline, 2 others."); muted line "Within your rules: short review · 1 of 2 today · verified organisation."; one primary button "Open the question"; ghost "Decline" link that works from the inbox and carries an optional reason. **Never the question text, never an attachment.** Fee line, see 4e, appears here too if the number is known at send.

### 4e. Request page (PWA)

Structure:
- app bar "Request · A2H-7f3c" with back; `pill.accent` "Short review · €30" and neutral pill "expires in 24h";
- h2 "From Galem L., Automi" (the accountable principal, as the policy shows them);
- the question **verbatim** as a quote block, exactly as the principal approved it;
- attachment card ("when_to_call.pdf · 140 words · opens here"), opened in the PWA, never downloaded silently;
- kv Format / Your answer (data terms: "Stored in their workspace · not published · not used for training") / Paid;
- bottom bar: primary "Accept and answer", ghost "Decline". No counter-offer, no price field.

Money line. **PRD wins (§8):** the platform fee is taken from the participant side and shown before acceptance: "€30 held · you receive what clears minus the platform fee (N%)". The prototype's "at least your €25 reserve" wording and the exact fee sentence are **OPEN (ADR 0002)**; keep the fee line present and mark the copy as open in design.md until the ADR lands.

Behaviour: accepting starts the timer the principal sees ("accepted at 16:44, has it open") and locks the hold. First paid request only, the "One check before your first paid answer" screen follows: ID via Stripe Identity (2 min), IBAN via Stripe (1 min), "Your request stays accepted and the hold is kept while you do this.", primary "Verify with Stripe", ghost "Answer first, verify before payout". Free lanes never see it; the PWA never handles documents or bank details.

### 4f. Answer form (PWA)

Fields in order, per the type's answer schema from `packages/protocol`:
1. verdict as a segmented control, the question's short form as its label ("Would a new patient find it alarming?"), options "Yes / No / Can't tell"; **"Can't tell" is first-class: same size, same position every time, never penalised**;
2. "How sure are you?" confidence 1–5 as five equal tap targets, mono digits;
3. the free part, labelled with the follow-on question: voice recorder (mic in `--human`, waveform, duration) **with the transcript shown under it for correction** ("Edit transcript" link), and a ghost "Type instead" that swaps to a textarea;
4. attestation row "I answered this myself" with `pill.human` "required", a checkbox the user must tick; it becomes part of the signature.
Bottom bar: primary **"Send answer · €30 held"**.

States: send disabled until verdict and attestation are set; recording and transcribing states on the recorder; transcription failure leaves the audio in place and offers typing; a draft survives a reload. **No model is ever called on this form, for drafting, suggestion or correction.**

Sent screen:
- cleared amount as a 40px display number ("€28"), lead "Cleared at the auction price (€30 bid, €25 reserve). Paid out Friday 24 Oct with your other answers." (fee shown here too, same OPEN wording as 4e);
- kv Request ("A2H-7f3c · answered in 7 min") / Signature / Your answer ("Can be cited by them as 'reviewed by M.V., 20 Oct 2026'");
- rating card "How was this request?" with five 34px stars and "Clear question, fair offer, respected your rules. Only A2H sees this.";
- line "They may ask one follow-up on this thread (€10). You can decline it."; primary "Done".

### 4g. Onboarding (five screens, plus the invitation)

Every screen: app bar with "n of 5" in mono, an ochre progress bar, one h2 in display face, one `p.lead`, at most one primary and one ghost action in the bottom bar.
0. Invitation email: "Sanne K. thinks you could answer questions like this"; referrer's real numbers ("6 questions in about 4 minutes each, €19 to €35"); an "Example of what arrives" card with a real question, asker type, price and effort; "You decide what you answer, at what price, and how often you're asked. Nothing reaches you until you've set that."; primary "See how it works · 1 min", ghost "Not for me". *Principle: show the thing before the form.*
1. Email: "Where should questions reach you?"; one field; "No app to install, no password."; work-domain hint ("can be used to confirm where you work, if you want"); primary "Send me a sign-in link". Magic link only.
2. Import: "Tell us what you know, the fast way"; LinkedIn and X rows with "Connect"; `card.teal` "**We read, we don't write.** Read-only access, used once to draft your topics. We never post, follow, or message for you. Disconnect any time."; primary "Connect LinkedIn", ghost "I'll type my topics instead" (equally first-class). *Principle: ask permission for exactly one thing, explain it, name what you will never do.*
3. Topics: "Does this look right?"; one screen of chips, each with its evidence label in small ("✓ job title", "✓ 3 posts"); "+ Add a topic"; card "Shown to agents as" with handle and `pill.accent` attestations and "Your name is shown only after you accept a request."; primary "Looks right". *Import, then edit; no more than one screen of chips.*
4. Rules: "Your rules"; "Agents must follow these. Out-of-scope requests are blocked before they reach you."; rows per request type with reserve (mono, right) and toggle; second card: free lane toggle, "I usually answer within", "At most n / day", "Quiet hours", "Who may ask"; primary "Save my rules". **PRD wins (§4):** no "Live calls" row; live calls are out of v1.
5. Published: "You're reachable"; the whole profile as **one plain-language paragraph** in a quote block; one "Pause everything" switch; `card.teal` "Paid answers need a one-time identity check (2 min, through Stripe) and a payout account. We'll ask when your first paid request arrives, not now."; primary "Done", ghost "Share my A2H page". *Onboarding ends at the first moment of value; verification and payout are deferred.*

### 4h. Participant home (PWA)

Four tiles (display numbers): paid out today, answered this month, median time to answer, "declined · N out of scope blocked" (the spam defence made visible). Request list: pending first, sorted by expiry, each row `pill` + type + asker or panel + right-aligned mono value (deadline or amount); then paid, free. `card.teal` demand panel: "N requests for 'topic' this month went to others at €25–40. You accept this type at €25. Review your rules" — prices as a range, never per-request bids. Bottom ghost "Profile & rules · Pause". Every row is reachable from an email link; the PWA is installable, never required.

### 4i. Principal contact policy and ledger

Policy, set once (`a2h.dev › Your contact policy`, h3 "How your agents may reach people"): a label/value grid (150px label column, stacks under 600px) with chip groups in the teal "on" state:
- Shown to humans as: real name · verified organisation only · verified person, pseudonymous;
- Monthly budget and per-request max, mono inputs;
- Ask me before: any expert request · anything over €X · any campaign to many people · every single request;
- Auto-approve: sensor polls under €Y · free lanes;
- Wording review: "Always show me the exact question" (default) · only when asked to approve;
- Answers reach me by: email (the only channel in v1);
- Data terms I offer: stored in my workspace · attributed publicly · may be used for training;
- Wallet: "€ 200 · Visa ···· 4421 · funded through Stripe, opened in your browser" (URL-mode elicitation, card details never pass through the client);
- one primary "Save policy". Everything decided here is what makes the per-request moment two actions instead of a form.

Ledger (`a2h.dev › Requests`):
- stats row: requests this month, spent of budget, median answer time, pending;
- table in a horizontal-scroll wrapper, mono uppercase headers Id · To · From agent / thread · Status · Cleared · Answered;
- status as pills (answered, "54 / 60" for campaigns, free lane, disputed); numeric cells mono tabular with `white-space: nowrap`; disputes show "€40 → refunded";
- one ledger for every agent and every client; this is where campaigns are watched, disputes raised and the budget reconciled.

### 4j. Notification email to the principal

Subject "Marieke V. answered your request". Body: "Your request `A2H-7f3c` about the Glucomate leaflet wording has an answer. Marieke V. answered personally, confidence 4/5, cleared at €28." (add "identity not yet verified" when applicable); "Open the thread **Glucomate patient leaflet** and your agent will pick the answer up and continue from it."; primary "Open the thread" (deep link to the originating thread, request id in the link, no PII in the URL), secondary "View answer here"; footer "You received this because A2H requests from your agents notify you by email. Change channel · Stop all A2H requests". One email per answer, nothing before.

## 5. States every screen specifies in design.md

For each screen, design.md names the copy and layout of:
- **empty**: what the first-time view says and what it invites (home before the first request, ledger before the first send);
- **loading**: skeleton blocks in `--chip`, no spinner-only screens;
- **error**: `--warn-soft` notice stating what happened and what to do, with a retry;
- **offline**: the PWA shows cached content and says sends will retry; the answer form keeps its draft locally;
- **expired**: "This request expired on … · nothing was charged"; the hold is released;
- **declined**: by the participant, reason optional; shown to the principal as a status, never as a name before acceptance;
- **blocked**: the manifest failed the participant's rules; counted on the participant's home ("1 out of scope blocked"), shown to the principal as a reason without the participant's identity.
Email templates additionally specify the plain-text fallback and image-less rendering.

## 6. Copy rules

- Plain language, second person, no jargon from the protocol ("manifest", "elicitation") in participant copy.
- Buttons state the consequence: "Send · hold €30", "Send answer · €30 held", "Accept and answer", "Connect and set my contact policy". "Don't send", "Decline", "Not for me" are the no-pressure alternatives.
- Money is always "€N" with what happens to it: held, cleared, returned, paid out Friday, nothing charged. The principal's worst case is the number on the button. Minor-unit integers are formatted at the edge, never computed in the UI.
- Competition without anxiety: "You first. If you decline, 2 others." Never a countdown race, never other people's bids.
- Names are withheld until acceptance: agents see handles and attested facts; the email names the asker (accountable principal), never the participant to the principal before acceptance.
- "Can't tell" is a full answer; copy never frames it as a failure.
- The platform shows its work: "Within your rules: …", "1 out of scope blocked", "Only A2H sees this".
- State the one thing never done next to every permission ("We never post, follow, or message for you").

## 7. Accessibility (WCAG 2.2 AA)

- Keyboard-complete: every action reachable by Tab, segments and confidence are radio groups with arrow keys, `<details>` for the collapsed line, native `<button>`/`<input>`/`<textarea>`.
- Focus: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` on both surfaces, never removed.
- PWA targets at least 44×44px: primary buttons 12px 16px padding at 15px type, segments, confidence, stars (34px visual inside a 44px hit area), toggles, chips.
- `@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important } }`; the waveform animates only when recording and respects it.
- Colour is never the only signal: every status pill carries text; the human card carries the eyebrow and attestation pill, not just the ochre border; chip "on" also sets `aria-pressed`/`aria-checked`.
- Every field has a visible `<label for>`; counts and hints via `aria-describedby`; the required attestation is announced as required.
- Steps and rails use `aria-current="step"`; navigation regions carry `aria-label`.
- Contrast, measured on the token pairs (light / dark): fg on paper 16.4 / 14.0; muted on paper 5.5 / 6.6 (principal), 6.0 / 6.1 (PWA); accent on paper 5.9 / 7.2; accent-ink on accent 5.9 / 6.6; human on paper 4.9 / 7.7; human-deep on human-soft 9.5 / 10.2; human-ink on human (PWA) 4.9 / 7.8; warn on warn-soft 5.8 / 5.2; ok on ok-soft 4.5 / 6.1. **Light `--pend` fails as text (3.3 on pend-soft, 3.6 on paper):** `packages/ui` must add a `--pend-ink` text variant that passes 4.5:1 and use it for pill text and pending copy; `--pend` stays for swatches and borders. Verify every pair in the Storybook a11y addon.
- Dark mode via `prefers-color-scheme` with `data-theme` override; both are tested.
- Language and direction set on `<html>`; voice notes always have a transcript.

## 8. Performance and PWA

- The request page loads under 2 s on 3G: server-rendered, fonts with `display=swap` and subset, no client JS required to read the question or decline, attachments lazy.
- Installable (manifest, icons, offline shell) but never required; every email link opens the PWA in the browser and deep-links to the request.
- Safe areas: page gutters `max(16px, env(safe-area-inset-left/right))`; bottom bar `padding-bottom: calc(16px + env(safe-area-inset-bottom))`; sticky bottom bar on `--paper` with a top border.
- Phone frame reference width is 390px; nothing scrolls horizontally except the ledger table wrapper.
- Email templates: React Email, table layout, tokens inlined at build time from `packages/ui`.

## 9. Design review on a preview

1. Open the PR's preview stage with the Playwright MCP.
2. Screenshot every screen in the change at **390px** and **1280px**, in **light and dark** (`prefers-color-scheme` emulation and `data-theme`), and with **reduced motion** on; attach them to the PR.
3. Keyboard-only pass: Tab through each screen, confirm order, visible focus, that the primary action is reachable and that Escape/back works.
4. Checklist, each item answered in the review comment:
   - tokens only, no hex in `apps/` or `packages/email`;
   - teal/ochre assignment matches §3;
   - copy matches §4 and §6, buttons state consequences, money lines complete;
   - every state in §5 exists and was screenshotted;
   - §7 items, including contrast of any new pair and 44px targets on the PWA;
   - request page timing under 2 s on throttled 3G in the Playwright trace;
   - email: no question text, summary fields present, decline link works from the rendered email.
5. Say what was tested and what was not. Block on any §10 item.

## 10. Never

- Never call a model in the answer form, or anywhere on the participant side.
- Never put the question text or an attachment in an email.
- Never show a bidding war: no per-request bids of others, no live counters, no countdown race.
- Never hardcode a colour; never ship a component outside `packages/ui` tokens.
- Never invert teal/ochre; a participant action is never teal, an agent/platform element is never ochre.
- Never add counter-offers, price negotiation or a "propose a price" field.
- Never add a "Live calls" lane or any synchronous format in v1.
- Never show a participant's name before acceptance, or identity before the principal's policy allows it.
- Never nag: one email on answer, one pending chip, nothing before.
