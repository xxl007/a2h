# Visual foundations: brainstorm material

Status: preparatory material for a brainstorm with the product owner, not a decision. Prepared by the Design agent, 21 October 2026. Nothing here changes `packages/ui`, the a2h-design skill or the prototypes; when a direction is chosen, §2–§3 of the skill are rewritten from it and an ADR records the choice.

Sources read: `CLAUDE.md` (the one rule, engineering rules), `docs/PRD.md` §2, §3, §6, §7, §8, §11, both prototypes in `docs/prototypes/` with their right-rail design notes, `.claude/skills/a2h-design/SKILL.md` §2–§3 and §7. Every contrast figure below was computed with the WCAG 2.x relative-luminance formula (SC 1.4.3 definition) and, as a secondary check, APCA-W3 0.0.98G-4g; the scripts are in the session scratchpad (`contrast.py`, `oklch.py`, `palettes.py`) and the numbers are reproducible from the hex values printed here. Font sizes were measured by downloading the latin woff2 subsets Google Fonts actually serves for the prototypes' `<link>`.

---

## 1. Who we are designing for, and where

**The participant** (PRD §2, §7) is an expert or a sensor with "no tolerance for spam", selling knowledge "in two-minute units". They open a thin summary email on a phone (§7.4), between other things, and either decline from the inbox in one tap or open a server-rendered request page that must load in under 2 s on 3G (§11). They answer with tap targets and a voice note (§7.6), possibly late in the day, with quiet hours and an interruption budget already enforced server-side (§7.3), so a request that arrives is by definition one they allowed. They are not an "app user": the PWA is opened from email, installable but never required (prototype home note).

**The principal** (PRD §2, §6) runs an agent in somebody else's client: Claude, ChatGPT, Codex, Claude Code, Cursor, "any MCP client" (§1). Our request card and the human-answer turn render as an MCP App inside a sandboxed iframe where the host supports it, as plain elicitation text where it does not, and as a boxed prompt in a terminal (§6.4, prototype "Nothing is lost without an iframe"). The principal also visits `a2h.dev` for the contact policy and the ledger (§6.2, §6.7), and receives one notification email per answer (§6.6).

What each context imposes:

| Context | Constraint on the foundations |
|---|---|
| MCP App card in a chat host | We are a guest: the host sets page background, font, dark/light, iframe width and height. Host context exposes theme and style hints; our card must read correctly on a host surface we do not control (white, warm off-white, slate, near-black) and must not fight the host's own accent. No fixed widths; a 320 px column is realistic. |
| Terminal (Claude Code, Codex) | 16 or 256 colours, one monospace face, no radii, no weights beyond bold/dim. Only hue semantics, copy and order survive. |
| a2h.dev dashboard | Fully ours. 1280 px reference, light and dark, data-dense table. |
| Participant PWA at 390 px | Fully ours. Thumb reach, 44 px targets (CLAUDE.md), safe areas, offline shell, reduced motion. Must load under 2 s on 3G: every web-font byte competes with the question text. |
| Email (participant summary, principal notification) | Table layout, inline styles, no web fonts in Gmail or Outlook, no `border-radius` or custom properties in Outlook desktop (Word renderer), dark-mode recolouring by the client that may invert or flatten our tints, images optional. Tokens are inlined at build time (skill §8). Only a subset of the system can exist here. |
| Dark mode | Inherited from the OS on the PWA and dashboard, from the host in an MCP App, from the mail client in email. Three different inheritance paths; the dark palette must be derived, not hand-picked, so all three stay consistent. |

---

## 2. Design principles derived from the product

These are the brief. Each is one sentence, each carries the product fact that justifies it.

1. **A human's words must look different from a machine's.** The answer "renders as a distinct human-origin turn" (PRD §6.6) and the participant's own actions are theirs (skill §3): origin is the one semantic the visual system must never lose, on any surface, for any viewer.
2. **Attention is the scarce resource.** "The human's attention is the scarce resource; the agent's convenience never wins a tie" (CLAUDE.md): every pixel on the participant side is paid for by someone who did not ask for it, so the email is thin, the page is skimmable in seconds, and nothing animates for decoration.
3. **Money is never ambiguous.** Hold = bid, "the principal's worst case is always the number on the button", clearing shown to both sides, fee shown before acceptance (PRD §8): amounts are set in one unmistakable style, tabular, with their verb (held, cleared, returned, paid out).
4. **Decline must be as easy as accept.** Asymmetric cost (PRD §3.3), decline from the email in one tap (§7.4), "Don't send" beside "Send" (§6.4): the no-pressure action is always present, always reachable, never visually punished.
5. **The card is a guest in someone else's UI.** The principal surface ships as a connector into clients we do not own (PRD §1, §6.4): the card borrows the host's background and type where it can, carries its own identity in one or two restrained signals, and degrades to text and to a terminal box without losing meaning.
6. **The platform shows its work.** "Within your rules", "1 out of scope blocked", "Only A2H sees this", ranking inputs shown in the result (PRD §7.3, §7.8, §9): small, factual, secondary text is a first-class role, not an afterthought, and must be legible.
7. **Reachable before beautiful.** WCAG 2.2 AA on PWA and dashboard (PRD §11), keyboard-complete, 44 px targets, reduced motion respected (CLAUDE.md): contrast, focus, target size and motion are inputs to the palette and scale, not a check at the end.

---

## 3. Audit of the incumbent prototypes

The prototypes are good product thinking; their design notes ("the question is the card", "the email is thin on purpose", "pending state is visible, not nagging") are the strongest material in the repository and are kept. The visual foundations underneath them were chosen quickly and show it.

### 3.1 Typography: Newsreader + Public Sans + JetBrains Mono

**Load cost (measured).** The prototypes' single Google Fonts `<link>` resolves, for a modern browser, to five variable latin woff2 files: Newsreader upright 132.0 KB and italic 63.3 KB, Public Sans upright 26.8 KB and italic 15.6 KB, JetBrains Mono 31.4 KB, total **269 KB** plus a 15 KB CSS response, served from two extra origins (`fonts.googleapis.com`, `fonts.gstatic.com`), each needing DNS, TCP and TLS. On Chrome's "Fast 3G" profile (1.6 Mbps, 560 ms RTT) the bytes alone take about 1.3 s and the two extra connections about 1.1–1.7 s more; the fonts roughly consume the entire 2 s budget of PRD §11 by themselves. `display=swap` keeps text visible but reflows the question after render. Newsreader alone is 73% of the bytes.

**Is the display serif earning its place?** It is used for headings, big numbers and quoted human text. On the PWA the serif carries the *question* quote (agent origin) and on the principal side the *answer* quote (human origin): the same voice for both origins, which contradicts principle 1. As a headline face at 24–40 px it is handsome but generic ("editorial startup" is the default of 2024–26). As a number face it is weak: Newsreader's default figures are proportional, not tabular, so "€28" and "€164 left" do not align in the ledger unless `font-variant-numeric` is forced, and the prototype uses mono for numbers anyway. Verdict: the serif is doing one defensible job (the human quote) and two undeserved ones (headings, money).

**Is the pairing distinctive?** Public Sans is USWDS's face, neutral and well hinted; JetBrains Mono is the most common developer mono. Serif display + neutral sans + dev mono is the default triad of the period; it is competent, not ours.

**Keep:** body 14–15 px at 1.5 line height; mono with `tabular-nums` for money, ids, counts and dates; eyebrows in small caps-style mono. These follow Butterick (body 15–25 px on screen, line spacing 120–145 %, 45–90 characters per line) and the prototype measure of 60–62 ch is right.

### 3.2 The hex palettes: every text/background pair

Light / dark WCAG 2.x ratios for the token pairs the prototypes actually use as text. "UI" means it passes only the 3:1 non-text or large-text bar (SC 1.4.11, SC 1.4.3 large).

| Pair | Principal (cool) L / D | Participant (warm) L / D | Verdict |
|---|---|---|---|
| `--fg` on `--paper` | 16.4 / 14.0 | 17.3 / 13.9 | pass |
| `--muted` on `--paper` | 5.5 / 6.6 | 6.0 / 6.1 | pass (APCA dark: Lc 50 and 47, below the Lc 60 body threshold) |
| `--muted` on `--chip` | 4.8 / 5.6 | 5.1 / 5.5 | pass, thin margin in light |
| `--accent` on `--paper` | 5.9 / 7.2 | 5.9 / 7.2 | pass |
| `--accent` on `--accent-soft` | 5.0 / 5.5 | 5.0 / 5.5 | pass |
| `--accent-ink` on `--accent` | 5.9 / 6.6 | — | pass |
| `--human` on `--paper` | 4.9 / 7.7 | 4.9 / 7.7 | pass, 0.4 above the line |
| `--human` on `--bg` | **4.46 / 8.4** | **4.43 / 8.4** | light fails as text on the page background (used for back links, legend labels) |
| `--human` on `--human-soft` | **4.2 / 6.3** | **4.2 / 6.3** | light fails as text; fine as the card border |
| `--human-deep` on `--human-soft` | 9.5 / 10.2 | 9.5 / 10.2 | pass |
| `--human-ink` on `--human` (PWA button) | — | 4.9 / 7.8 | pass, 0.4 above the line |
| `--pend` on `--paper` | **3.6 / 8.6** | **3.6 / 8.6** | light fails as text |
| `--pend` on `--pend-soft` (pill text) | **3.3 / 6.7** | **3.3 / 6.7** | light fails as text (already noted in skill §7) |
| `--ok` on `--ok-soft` | 4.5 / 6.1 | 4.5 / 6.1 | pass by 0.01 |
| `--warn` on `--warn-soft` | 5.8 / 5.2 | 5.8 / 5.2 | pass |
| `--line` on `--paper` | 1.4 / 1.4 | 1.4 / 1.3 | fails 3:1; acceptable for decorative rules, not for input boundaries (SC 1.4.11) |

Findings: four light-mode pairs fail as text, two more pass by less than 0.05, and the light palette is systematically tighter than the dark one, which is the signature of hand-picked hex rather than a lightness ladder. Inputs are bounded only by `--line` at 1.4:1, so a text field on `--paper` has no 3:1 boundary and relies on its `--chip` fill. Dark `--muted` is WCAG-clean but APCA-weak, a known divergence (APCA penalises light-on-dark more) worth adopting as a check.

### 3.3 Two neutral palettes for two surfaces

Cool slate for the principal, warm paper for the participant. The intent is readable (machine room vs human room) and it is a legitimate idea. The cost: every component exists in two neutral contexts, every screenshot review doubles, the brand has no single neutral, and the MCP card is a guest anyway so its slate rarely shows. The warmth is also tiny: the warm `--bg` is OKLCH chroma 0.006, the cool one 0.003; side by side they read as "two slightly different greys", which is the worst of both outcomes (fragmentation without a felt difference). Either commit to a warmth that is visible, or carry warmth as a single primitive hue parameter that one theme can set, rather than two palettes.

### 3.4 Teal for agent, ochre for human

**Is the semantic right?** Yes, and it is the best decision in the prototypes. Warm for the human hand and cool for the machine is culturally legible, and the rule "never inverted" is correct. Keep the semantic; what follows is about its execution.

**Colour-blind legibility.** In OKLab the two hues sit on opposite sides of the blue–yellow axis (teal b = −0.03, ochre b = +0.11), which is the axis preserved under the common red–green deficiencies, so the *hue* pair is a safe one (it is the orange/bluish-green pairing of the Okabe–Ito set). The weakness is lightness: light teal L 0.49 vs ochre L 0.56, dark 0.72 vs 0.76. In greyscale, on an e-ink reader, in a terminal with dim colours or for a monochromat the two are indistinguishable (ratio between them 1.2:1 light, 1.1:1 dark). The prototypes partly cover this with text ("Answer from a human", "attested · answered personally") and skill §7 says colour is never the only signal, which is right; but no second *visual* channel exists yet (a typographic register, a border weight, a glyph, a layout position). SC 1.4.1 is satisfied by the text; principle 1 is not yet satisfied robustly.

**Hue collision inside our own palette.** `--pend` (#b7791f) is OKLCH hue 70; `--human` is hue 59 light and 69 dark. Pending status and human origin are the same amber family. A "pending" pill beside a human card reads as one more human thing. Pending should leave the ochre family (neutral or slate) or human should move; one of the two.

**Robustness against the host.** Chat hosts use their own accents: at least one major host's web UI is a warm off-white with a terracotta accent (close to our *ochre*, to verify on the preview), others are neutral grey with a green or blue action colour. A teal primary button inside such a host looks like a third-party widget; an ochre human card beside a terracotta host accent risks reading as host chrome. In an MCP card, the agent/platform signal probably should not be a saturated hue at all; a neutral ink button with our mark is harder to collide with. On the dashboard and PWA, where we own the page, a hue accent is fine.

### 3.5 Radii, spacing and type sizes

Measured across both prototypes:

- **Radii:** 2, 3, 6, 8, 9, 10, 11, 12, 14, 28, 999 px and the `14 14 4 14` bubble. Eleven values, no scale; the PWA button (12) and card (14) differ from the principal button (8) and card (10) for no stated reason.
- **Spacing:** gaps 4, 6, 8, 10, 12, 14, 16, 20, 24; paddings `14 16`, `18 20`, `10 12`, `8 10`, `7 12`, `6 10`, `5 8`, `5 11`, `4 10`, `4 14`. Roughly half the values are off a 4 pt grid. The 14 px stack rhythm is the most-used value and is not on the grid.
- **Type:** 11, 12, 12.5, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 34, 40 px: fifteen sizes, no ratio, with 12.5 and 17 appearing once each. Line heights 1, 1.1, 1.15, 1.2, 1.45, 1.5, 1.6.
- **Motion:** one transition (`left .15s` on the toggle) and a correct global reduced-motion kill switch. Motion is near-absent, which fits principle 2; it just has no tokens.
- **Targets (PWA):** the primary button clears 44 px (12 px padding at 15 px type); chips are about 33 px tall and are toggles on the topics screen; `.btn.sm` about 35 px; segmented buttons about 40 px; the mic 40 px; the toggle 38 × 22 px, which is under the WCAG 2.2 SC 2.5.8 24 px minimum unless spacing saves it, and well under CLAUDE.md's 44 px and Apple HIG's 44 pt.

The uppercase mono eyebrow with 0.06–0.08 em tracking is a good, keepable detail (Butterick: letterspace capitals 5–12 %). The `text-wrap: balance` on headings and the `max(16px, env(safe-area-inset-*))` gutters are correct and stay.

### 3.6 Summary

Keep: the semantic (warm human, cool or neutral machine, never inverted); mono tabular numerals for money and ids; 15 px / 1.5 body on the PWA; eyebrow treatment; 16 px safe-area gutters; the reduced-motion default; the restraint (no decoration, one transition). Weak: three web fonts for 269 KB against a 2 s budget; the serif speaking for both origins; hand-picked hex with four light-mode text failures and a pending/human hue collision; hue-only origin coding with near-equal lightness; two faint neutral palettes; no radius, spacing or type scale; several sub-44 px controls.

---

## 4. First-principles method proposed for the foundations

1. **Three token layers** (Material 3 roles, Radix 12-step scales, USWDS grades all do a version of this): *primitive* (`--gray-1…12`, `--ochre-1…12`, OKLCH-defined), *semantic* (`--surface`, `--text`, `--text-muted`, `--border`, `--border-strong`, `--action`, `--on-action`, `--human`, `--human-soft`, `--human-text`, `--success`, `--pending`, `--danger`, `--focus`), *component* (`--card-bg`, `--button-primary-bg`…). Apps and email reference semantic or component tokens only; primitives never leave `packages/ui`.
2. **OKLCH primitives on a lightness ladder.** Twelve steps per hue at fixed L values (about 0.99, 0.97, 0.94, 0.90, 0.84, 0.76, 0.66, 0.56, 0.48, 0.40, 0.30, 0.20), chroma shaped per hue and clipped to the sRGB gamut, hex emitted at build. Perceptual evenness is the point of OKLCH; it is what makes "step 9 of any hue is text-safe on step 1" a rule rather than a hope (Radix's step 11 and USWDS's "50-grade difference ≈ 4.5:1" are the same idea).
3. **Contrast targets per role, tested in CI.** Text ≥ 4.5:1 (SC 1.4.3), large text and UI boundaries ≥ 3:1 (SC 1.4.3, 1.4.11), focus indicator ≥ 3:1 against adjacent colours (SC 2.4.11 for not-obscured, 2.4.13 as the AAA aspiration); APCA as a second gate (Lc 75 body, Lc 60 secondary text, Lc 45 large or non-text), which will push dark-mode muted text lighter than WCAG alone would (L 0.76 rather than 0.72, see §5).
4. **Decorative borders may fail 3:1; control boundaries may not.** Two border tokens (`--border` hairline, `--border-strong` ≥ 3:1), or filled inputs.
5. **One modular type scale on a 4 pt baseline.** Ratio 1.2 (minor third) from a 14 px dashboard base, rounded to whole pixels: 12, 14, 17, 20, 24, 29, 35, 42; the PWA shifts one step up the same ladder (15, 18, 22, 26, 31, 37) so the two surfaces share a ratio, not a size. Line heights from the grid (16, 20, 24, 28, 32, 40). Five roles, Material-style: display, title, body, label, mono. Nothing at 12.5 or 17 by accident. Honour `font-size` user settings by sizing in `rem` (SC 1.4.4 resize to 200 %, Apple Dynamic Type as the model).
6. **Spacing scale** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 with 2 as a hairline exception. Stack rhythm 12 or 16, not 14.
7. **One radius scale**: 4 (small controls, chips in dense UI), 8 (buttons, inputs), 12 (cards), 9999 (pills), 50 % (avatars). Which step a surface uses is the only per-direction choice.
8. **Motion tokens**: durations 100 / 150 / 250 ms, one standard ease and one decelerate ease; reduced motion is the *default* stylesheet and motion is added under `@media (prefers-reduced-motion: no-preference)`, the inverse of the current kill switch, so forgetting a rule fails safe.
9. **Dark theme derived, not hand-picked**: the same hue and chroma ladder, lightness mirrored around the midpoint with chroma reduced about 10 % on the dark side, surfaces at L 0.15–0.23, text at L 0.94–0.96. One file, one parameter.
10. **Subset rule.** Email uses semantic tokens only, inlined, no web fonts, no `border-radius`, no custom properties, and is tested in dark-mode recolouring. The MCP card uses a *guest subset*: no page background, host font where available, our human hue and our ink only, radius ≤ 8.
11. **Targets**: 44 × 44 px minimum on the PWA for every control including chips and toggles (CLAUDE.md; Apple HIG 44 pt; above the WCAG 2.2 SC 2.5.8 24 px floor), 32 px minimum on the dashboard with 8 px spacing.

---

## 5. Three candidate directions

All three use the method in §4, the same semantic layer, the same type scale and spacing scale, and a human hue on the warm side; they differ in neutral, type pairing, accent strategy, radius character and the second channel for origin. Primitives are given as OKLCH `(L C h)` with the hex the converter produced; chroma shown is after gamut clipping. WCAG ratio is against `surface` unless noted; APCA Lc in brackets.

### A. Ledger

**Intent.** A2H is a record of consented exchanges with money attached: a ledger, not a chat skin. Near-achromatic, document-like, hierarchy carried by rules and type rather than tints. Agent and platform are *ink*: dark buttons, underlined links, no teal. The only chromatic hue in content is the human one, so a human's words are the one coloured thing on the page, which is the strongest possible form of principle 1 and the most host-proof form of principle 5. Status hues (success, danger) exist but are rare. Pending is neutral because waiting is not an alert.

| Role | Light | Dark |
|---|---|---|
| surface | `(0.99 0.004 70)` #fefbf9 | `(0.17 0.004 70)` #110f0e |
| surface-2 (fields) | `(0.96 0.004 70)` #f5f3f1 | `(0.21 0.004 70)` #191816 |
| text | `(0.22 0.004 70)` #1c1a19 · 16.8 [102] | `(0.95 0.004 70)` #f0eeec · 16.5 [97] |
| muted | `(0.49 0.004 70)` #62605e · 6.1 [79] | `(0.76 0.004 70)` #b3b1ae · 8.9 [60] |
| border / border-strong | #d9d7d5 · 1.4 / #888684 · 3.5 | #2f2d2c · 1.4 / #6a6866 · 3.5 |
| action (agent/platform) | ink #1c1a19 · 16.8; on-action #fefbf9 | ink #f0eeec; on-action #110f0e |
| human | `(0.50 0.112 65)` #8e5300 · 6.0 [78] | `(0.78 0.110 70)` #e5ab66 · 9.4 [63] |
| human-soft / human-text | #fceedb / `(0.38 0.090 60)` #643400 · 9.1 on soft | #2d2114 / `(0.88 0.080 75)` #f7d19c · 10.9 on soft |
| success | `(0.47 0.100 150)` #296a3b · 6.3 | `(0.78 0.120 150)` #7ccd8e · 10.0 |
| pending | = muted (outlined pill, text "pending") | = muted |
| danger | `(0.47 0.150 25)` #9e2c2c · 7.2 | `(0.74 0.140 25)` #f7857d · 7.8 |

**Type.** One variable sans with an optical-size axis for everything (candidates: Inter 4 with `opsz`, or Source Sans 3), latin subset, two files (upright, italic) under about 60 KB; mono from the system stack (`ui-monospace, SFMono-Regular, Menlo, Consolas`) for ids, hashes and terminal parity; money set in the sans with `tabular-nums` and `lining-nums` (Inter and Source Sans 3 both have them). No serif. Human words are distinguished typographically by *italic at the body size with a left rule in the human hue*, not by a different family. **Radius and density:** 4 / 8 / 12, dense (dashboard rows 40 px, PWA 44 px), 1 px rules everywhere, very little fill. **Origin channels:** hue (ochre vs ink), lightness (L 0.50 vs 0.22, ratio 2.8:1 between them, survives greyscale), typography (italic + rule). Three channels. **Trade-offs:** austere; the PWA may feel cold for a consumer-ish participant; teal disappears from the brand (the role file's "teal = agent" becomes "ink = agent", same semantic, different hue); a single accent means links and primary buttons are both ink, so button shape must do the work.

### B. Field notebook

**Intent.** The participant is a person being asked for their experience; the product should feel like a well-made notebook, warm paper and a serif reserved for what humans say. The incumbent's instincts (warm neutral, ochre hand, serif quote) kept and made rigorous: warmth that is actually visible (chroma 0.012, not 0.006), one neutral for both surfaces so the brand is one thing, teal retained as the agent/platform accent on surfaces we own and dropped to ink inside hosts. The serif is used for *human words only*: the answer quote on the principal side, the participant's own transcript on the PWA, the plain-language profile paragraph. The question (agent origin) is set in the sans. Pending moves to slate so nothing but humans is amber.

| Role | Light | Dark |
|---|---|---|
| surface (paper) | `(0.97 0.012 75)` #fcf6ee | `(0.19 0.010 75)` #16130f |
| surface-2 (cards) | `(0.99 0.004 75)` #fffdfa | `(0.23 0.010 75)` #201c18 |
| text | `(0.24 0.012 75)` #231f19 · 15.3 [98] | `(0.94 0.010 75)` #efeae4 · 15.5 [94] |
| muted | `(0.48 0.015 75)` #635d54 · 6.1 [77] | `(0.76 0.012 75)` #b5b0aa · 8.6 [59] |
| border / border-strong | #d6d0c9 · 1.4 / #867f77 · 3.7 | #36322d · 1.5 / #6d6861 · 3.4 |
| action (teal) | `(0.47 0.079 195)` #056868 · 6.1 [77]; on-action #f9fdfc · 6.4 | `(0.78 0.090 195)` #6bcac9 · 9.6; on-action #021818 · 9.5 |
| human (ochre) | `(0.52 0.122 60)` #9a5500 · 5.3 [73] | `(0.79 0.110 70)` #e8ae69 · 9.4 [64] |
| human-soft / human-text | #fde7cf / `(0.38 0.094 55)` #673200 · 8.6 on soft | #342210 / #f7d19c · 10.5 on soft |
| success | #296a3b · 6.1 | #7ccd8e · 9.7 |
| pending (slate) | `(0.48 0.060 250)` #43607e · 6.1 | `(0.76 0.060 250)` #95b5d6 · 8.7 |
| danger | #9e2c2c · 6.9 | #f7857d · 7.6 |

**Type.** Humanist sans for UI and agent text (Source Sans 3 variable, about 40 KB latin for upright + italic; or system-ui on the 3G path with Source Sans as progressive enhancement), a serif for human words only (Source Serif 4 variable with `opsz`, or the incumbent Newsreader if the owner is attached to it; one upright file, no italic, about 60–70 KB, loaded only on screens that contain human words), system mono for ids and money. Headlines in the sans, not the serif, so the serif is unambiguous: serif = a person said this. **Radius and density:** 8 / 12 / 16, relaxed, cards on paper with a 1 px warm border, generous 16 px stacks. **Origin channels:** hue (teal vs ochre, blue–yellow axis), typography (sans vs serif, the strongest and most greyscale-proof signal of the three directions), and a soft fill. Lightness is *not* a channel (L 0.47 vs 0.52, 0.78 vs 0.79), so the serif must always accompany the hue. **Trade-offs:** the warmest and most human of the three, and the closest to the incumbent so least disruptive; two web fonts (about 100–110 KB) or a system-stack fallback on the request page; the serif is a dependency for principle 1 and cannot be loaded in email or in a terminal, so those surfaces fall back to hue plus labels; warmth inside a cool host looks foreign unless the guest subset drops the paper.

### C. Instrument

**Intent.** A2H is infrastructure: a protocol with signatures, holds, clearing prices and attestations. Cool, precise, high-contrast, mono-forward. Everything the machine says or measures (eyebrows, ids, money, status, timestamps, the question as the agent drafted it) is set in mono; the only proportional type on a card is the human's answer. The typographic register *is* the origin signal, with hue as reinforcement. Neutral is a cool slate; the agent accent is a clearer cyan-teal; the human hue is amber. Pending is neutral mono text.

| Role | Light | Dark |
|---|---|---|
| surface | `(0.98 0.004 240)` #f8fafd | `(0.15 0.012 240)` #070c10 |
| surface-2 (panels) | `(0.95 0.008 240)` #ecf1f5 | `(0.19 0.012 240)` #0f1519 |
| text | `(0.18 0.015 240)` #0c1318 · 17.9 [102] | `(0.96 0.005 240)` #eff2f5 · 17.5 [99] |
| muted | `(0.46 0.020 240)` #4e5a62 · 6.8 [81] | `(0.76 0.020 240)` #abb2b8 · 9.2 [60] |
| border / border-strong | #c5cbd0 · 1.6 / #707c85 · 4.1 | #262c31 · 1.4 / #59656e · 3.3 |
| action (cyan-teal) | `(0.46 0.078 200)` #016569 · 6.6 [80]; on-action #f9fdfd · 6.7 | `(0.80 0.110 200)` #56d3da · 11.0; on-action #000f10 · 10.9 |
| human (amber) | `(0.53 0.114 70)` #955e02 · 5.2 [74] | `(0.80 0.130 75)` #eeb154 · 10.3 [66] |
| human-soft / human-text | #fdecd1 / `(0.40 0.090 65)` #683c00 · 8.1 on soft | #2e1e0a / `(0.89 0.090 80)` #fad596 · 11.5 on soft |
| success | `(0.47 0.110 150)` #206b38 · 6.2 | `(0.79 0.130 150)` #79d28d · 10.7 |
| pending | = muted, mono | = muted, mono |
| danger | `(0.47 0.160 25)` #a12628 · 7.1 | `(0.75 0.140 25)` #fa8880 · 8.3 |

**Type.** One mono as the primary face (JetBrains Mono variable 31 KB, or IBM Plex Mono / Commit Mono) at 12–14 px for labels, numbers, eyebrows, table cells and agent text; one neutral grotesk (Inter or IBM Plex Sans, about 50 KB) at 15–17 px for the human's words and long body copy; no serif. Two files, about 80 KB. Money and ids are unambiguous by construction (everything measured is mono tabular). **Radius and density:** 2 / 4 / 8, dense, square pills, 1 px borders at `border-strong` so every control has a 3:1 boundary. **Origin channels:** typography (mono machine vs proportional human, greyscale-proof and terminal-proof since a terminal is *all* mono and the human turn becomes the thing that is set differently by indentation and rule), hue (cyan vs amber, blue–yellow axis), fill. Lightness is not a channel (L 0.46 vs 0.53; 0.80 vs 0.80 in dark). **Trade-offs:** mono body text at 13 px is tiring for a nurse on a phone at 22:00 (principle 2 cuts against it on the PWA; the PWA would use the grotesk for everything and keep mono for numbers, which weakens the concept there); high chroma dark accents glow in a dark host; the coolest and most "developer" of the three, which fits Claude Code and Cursor and fits the participant least.

### Evaluation against the principles

Scores are 1–3 (3 best), with the reason in the cell.

| Principle | A. Ledger | B. Field notebook | C. Instrument |
|---|---|---|---|
| 1 Human ≠ machine | **3** hue + lightness + italic rule; only coloured thing on the page | **3** hue + serif; serif unavailable in email/terminal | **3** hue + mono/proportional; weakest on the PWA where mono body is dropped |
| 2 Attention scarce | **3** nothing decorative, 1 font | **2** warm fill and serif add weight; still restrained | **2** dense mono asks more reading effort on a phone |
| 3 Money unambiguous | **2** sans tabular figures; needs a mono fallback for ids | **2** system mono for money; serif never touches numbers | **3** every number is mono tabular by construction |
| 4 Decline as easy | **3** ink primary and ghost are both calm | **3** same | **2** dense, square controls make the ghost easy to miss unless sized |
| 5 Guest in a host | **3** no accent hue to collide; host font acceptable | **2** paper and teal must be dropped inside hosts (guest subset carries the load) | **2** cyan collides with blue/teal hosts; mono reads as "code block" in chat |
| 6 Platform shows work | **2** secondary text is small ink; must stay ≥ 6:1 | **3** muted warm text at 6.1:1 reads as a kind aside | **3** mono meta text is the house style |
| 7 Reachable first | **3** 1 font ≈ 60 KB; fits the 3G budget with room | **2** about 100–110 KB of fonts or a system fallback on the request page | **3** about 80 KB; high contrast throughout |
| Fonts on the request page (latin woff2) | about 60 KB | about 100–110 KB (or 0 with system stack) | about 80 KB |
| Distance from the incumbent | far | near | medium |

Reading of the table: A is the safest answer to the brief as written (principles 2, 5, 7 are where the incumbent is weakest and A wins all three). B is the most humane and the least disruptive, and keeps the owner's existing visual intent. C is the most coherent as a protocol brand and the least suited to the participant at night. A plausible hybrid the brainstorm should consider: A's token system and ink-as-agent inside hosts, with B's serif for human words on surfaces we own.

---

## 6. Questions for the product owner

Each is a fork. The recommendation is where the brainstorm starts, not where it must end.

1. **One brand across both surfaces, or two moods (cool machine room, warm human room)?** Recommendation: one neutral, one brand; carry any warmth as a single parameter, because two faint greys fragment the system without being felt (§3.3).
2. **Web fonts, or the system stack on the 3G-critical request page and email?** Recommendation: system stack by default on the request page and in email, one variable web font (≤ 60 KB) as progressive enhancement elsewhere; the fonts currently cost the entire 2 s budget (§3.1).
3. **Should the human hue be warm at all, and should the agent have a hue?** Recommendation: human stays warm (ochre/amber; it is the right semantic and a colour-blind-safe pair with teal), agent/platform becomes *ink* inside hosts and may keep teal on surfaces we own; and pending leaves the amber family (§3.4).
4. **Serif or not?** Recommendation: no display serif for headings or numbers; a serif only if it is reserved for human words and loaded only where they appear (direction B); otherwise none (direction A).
5. **How much personality may the card have inside a host?** Recommendation: a guest subset with no background, host font where available, our ink and our human hue only, radius ≤ 8, so the card reads as part of the conversation and not as an embedded widget (§4.10).
6. **Which direction is the default?** Recommendation: **A. Ledger**, with B's serif-for-human-words as an optional enhancement to prototype beside it, because A is the only direction that wins on attention, guest behaviour and the 3G budget at once, which are exactly the three places the incumbent is weakest.

---

### Appendix: how to reproduce the numbers

- WCAG ratios: relative luminance per WCAG 2.2 SC 1.4.3 definition, `(L1 + 0.05) / (L2 + 0.05)`.
- APCA: APCA-W3 0.0.98G-4g (soft clamp 0.022, exponents 0.56/0.57 normal and 0.65/0.62 reverse polarity, scale 1.14, offset 0.027). Thresholds cited from the APCA readability lookup: Lc 75 body, Lc 60 secondary, Lc 45 large/non-text.
- OKLCH → sRGB: Ottosson's OKLab matrices, chroma reduced in 0.002 steps until in gamut, then rounded to 8-bit hex. Hex values above are therefore the sRGB truth; the OKLCH is the intent.
- Font sizes: the woff2 URLs with `unicode-range: U+0000-00FF` from the prototypes' Google Fonts CSS, fetched with a Chrome UA on 21 October 2026.
- References by name: WCAG 2.2 SC 1.4.1, 1.4.3, 1.4.4, 1.4.11, 2.4.7, 2.4.11, 2.4.13, 2.5.8; APCA-W3 (Myndex); Material 3 colour roles and tonal palettes, Material type scale; Radix Colors 12-step scale semantics; USWDS colour grades ("magic numbers" 40/50/70); Butterick, *Practical Typography* (point size, line spacing, line length, letterspacing of capitals, font count); Apple HIG (44 pt targets, Dynamic Type); Okabe & Ito colour-universal palette; Can I email and Litmus client-support tables for email CSS limits.
