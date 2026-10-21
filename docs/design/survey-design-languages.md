# Survey: design languages A2H can benchmark against

Status: research input for the visual-identity decision, not a decision. Prepared by the Design agent on 21 October 2026 for the product owner. Companion to `foundations-brainstorm.md` (which audits our own prototypes); this file looks outward. Nothing here changes `packages/ui`, the a2h-design skill or the prototypes.

Scope of the track: the *design language* of mature products and public design systems (typography, colour discipline, density, how money and trust are rendered, how human and machine content are told apart, how a product behaves as a guest in someone else's UI or in email). Component libraries are out of scope.

## 0. Method and verification legend

- Every factual claim carries its source URL and the date it was read. All sources were read on **21 Oct 2026** unless another date is stated.
- **[live]**: read from the product's own documentation or extracted from its live HTML/CSS on that date (fonts and colour tokens were pulled from the served stylesheets with `curl`, so they describe what ships, not what a blog says).
- **[3rd]**: third-party description (reverse-engineered "DESIGN.md" sites, galleries, articles). Treated as hints, never as fact.
- **[unverified]**: could not be checked; stated so the owner knows what is missing.
- Pages that refused automated reading (HTTP 403/404 or JavaScript-only) are listed in §5.

What A2H needs from a reference, in the order the PRD imposes it (PRD §3, §6.4, §6.6, §7.4, §11; CLAUDE.md "the one rule"): (a) a human's words must look different from a machine's; (b) money must be unambiguous and tabular; (c) the card is a guest inside Claude/ChatGPT/Cursor/terminals; (d) the participant surface is a thin email plus a phone page under 2 s on 3G; (e) WCAG 2.2 AA, 44 px targets, reduced motion.

---

## 1. References

Each entry: what it is and for whom · typography · colour · density · money · provenance · guest/email behaviour · accessibility · public system · **Take / Avoid**.

### 1.1 Stripe: Elements Appearance API, Connect embedded components, receipts

- **What / who.** Payment UI embedded in millions of third-party sites; the de-facto reference for "money UI that lives inside someone else's page". Platform developers and their end customers.
- **Typography.** Default `fontFamily: 'Ideal Sans, system-ui, sans-serif'`; `fontSizeBase` drives the whole scale in `rem`; explicit advice to keep inputs at ≥16 px on mobile. Connect components expose a full semantic type ramp (`headingXl` 28 px … `headingXs` 12 px, `bodyMd` 16, `bodySm` 14, `labelMd` 14, `labelSm` 12) with weight and text-transform per role. Sources: https://docs.stripe.com/elements/appearance-api.md?api-integration=paymentintents [live]; https://docs.stripe.com/connect/embedded-appearance-options.md [live].
- **Colour.** Three themes (`stripe`, `night`, `flat`); defaults `colorPrimary #0570de`, `colorText #30313d`, `colorDanger #df1b41`, `colorBackground #ffffff`. Text-on-colour is derived automatically (`accessibleColorOnColorPrimary`, `…OnColorDanger`, etc.). Connect adds a four-state badge system, each state a background/border/text triplet: neutral `#E4ECEC/#CBD5D6/#545969`, success `#CEF6BB/#B4E1A2/#05690D`, warning `#FCEEBA/#F5DA80/#A82C00`, danger `#F9E4F1/#F2C9E3/#B3063D`. Dark mode is the host's problem: Stripe exposes variables, not a theme switch. Same sources [live].
- **Density.** `spacingUnit` (Elements default 2 px, Connect default 8 px) derives all spacing; `borderRadius` 4 px (Elements) / 15 px (Connect default). Same sources [live].
- **Money.** Receipts: amount, public business information and the `description` only, no line items; brand colour + accent colour + square logo/icon ≥128 px; legal name, support address, support email and privacy URL are mandatory on every receipt. https://docs.stripe.com/receipts.md [live]; one-time receipt content per https://docs.stripe.com/payments/advanced/receipts (seen via search snippet, 21 Oct 2026) [3rd].
- **Provenance.** None in the visual language; Stripe is single-origin (the platform speaks).
- **Guest behaviour.** The variables are *the only* styling path: "You can't override their styles with CSS selectors or other mechanisms"; authentication popups cannot be removed. A Figma toolkit of every component is public. https://docs.stripe.com/connect/embedded-appearance-options.md [live].
- **Accessibility.** Contrast is engineered in (auto "accessibleColorOn…" tokens); 16 px minimum for inputs. [live, same page]
- **Public system.** No public design system (Sail is internal); the Appearance API docs and the Connect Figma kit (https://www.figma.com/community/file/1438614134095442934) are the public surface.
- **Take.** The badge triplet (bg/border/text) per status; derived text-on-colour; a single `spacingUnit` and `fontSizeBase` so the card can re-scale to a host. **Avoid.** Default uppercase labels and 15 px radii (Connect defaults look like a bank widget, not a conversation turn); no idea of human vs system origin.

### 1.2 Wise (ex-TransferWise)

- **What / who.** Consumer and SMB cross-border money; a brand built on "we show you the fee". Rebranded 1 March 2023: "Goodbye blue, hello green." https://wise.com/gb/blog/a-brand-for-everywhere-wise-unveils-bold-new-look [live].
- **Typography.** Served tokens: `--font-family-display: "Wise Sans","Inter",sans-serif`; `--font-family-regular: "Inter",Helvetica,Arial,sans-serif`; `WiseSans-Heavy.woff2` and an Inter variable file are the only web fonts loaded. Numbers that count up use `font-feature-settings:"tnum"` plus `font-variant-numeric: tabular-nums`. Extracted from https://wise.com stylesheets [live].
- **Colour.** `--color-bright-green #9fe870`, forest `#163300` (used as `--color-content-primary` in light and as background in dark, so the pair simply swaps). Status: positive `#008026`, negative `#cf2929`, warning `#9a6500`, each with hover/active steps. Dark mode is a first-class token flip. Same stylesheets [live].
- **Density.** Soft and roomy: radii 10/16/24/32 px (`--radius-small … --radius-xlarge`). [live]
- **Money.** The brand *is* the fee breakdown; the rebrand post frames the mission as replacing a system that is "clunky, opaque and expensive" and having "shone a light on hidden fees". [live, rebrand post]
- **Provenance.** None needed; single voice.
- **Guest / email.** Not applicable (Wise is the host). wise.design lists brand sections (Flags, Cards, Icons, Illustration, Logo, Motion, Photography, Tone of Voice, Typography, Colour) but the pages are JavaScript-only and docs.wise.design redirects to a 404. https://wise.design/ , https://wise.design/direction [live, index only].
- **Accessibility.** No statement found in the rebrand post; the token set has hover/active steps for every semantic colour, which is a good sign. [live]
- **Public system.** Partial: wise.design exists but its documentation was not readable; the old Neptune repo is gone (404). [unverified beyond the index]
- **Take.** One loud brand colour used as a *surface*, with a dark counterpart it swaps with; status hues kept apart from brand; tabular numerals wherever a number moves. **Avoid.** Heavy display weights and 24–32 px radii; a bright-green identity would fight every chat host's palette.

### 1.3 Mercury

- **What / who.** US business banking web app, often cited as the benchmark for a calm money dashboard. Founders and finance teams. [3rd for the reputation: https://blakecrosley.com/pl/guides/design/mercury]
- **Typography.** The app loads `ArcadiaDisplay-Variable.woff2`, `ArcadiaText-Variable.woff2` and `PPNeueMontreal-Variable.woff`; the design system exposes `--ds-font-family-text` and `--ds-font-family-monospace`. The marketing site adds Tiempos Headline (serif) for editorial headings. Extracted from https://app.mercury.com and https://mercury.com HTML/CSS [live]. Third-party claims of weights 360/420/480 and 0.42 px tracking: [3rd, unverified].
- **Colour.** Tokens are namespaced `--ds-*` and paired light/dark: canvas `#ededf3` / `#10101a`, default surface `#fff` / `#171721`, borders are *alpha* neutrals (`#7073931a` light, `#b4b7c81f` dark) so they sit on any surface; focus ring `#707393` / `#b4b7c8`; error is a magenta `#d03275`, not red. Category colours (budget blue/green/pink/purple/yellow) each ship as a card/tag/icon triplet with very low-chroma backgrounds. Extracted from `cdn.mercury.com/builds/…/static/css/DS*.css` [live].
- **Density.** Radii 4/8/12 px (`--ds-border-radius-small/medium/large`); hairline alpha borders; dark canvas is near-black indigo rather than grey. [live]
- **Money.** Marketing copy: "total visibility" snapshot of funds in and out; third-party galleries (saasframe.io) describe balance-first dashboards and a recipient → method → fee-option → confirm payment flow. https://mercury.com [live]; https://www.saasframe.io/examples/mercury-transactions-dashboard [3rd].
- **Provenance.** None in the language.
- **Guest / email.** Not a guest anywhere. [n/a]
- **Accessibility.** Not documented publicly. [unverified]
- **Public system.** None; the `DS*` CSS chunks prove an internal design system exists but nothing is published.
- **Take.** Alpha-neutral borders and focus rings that work on any host background; a two-level surface (canvas / default) with mirrored dark values; 4/8/12 radii. **Avoid.** Proprietary display faces and a serif for marketing headings: it is the "editorial fintech" default our brainstorm already flagged as generic.

### 1.4 Qonto (France)

- **What / who.** French business account and invoicing for SMEs; the French fintech most of our participants will have seen. https://qonto.com/en [live].
- **Typography.** One family: `QontoSans` regular and semibold, declared `font-family: QontoSans, sans-serif` twenty times on the French home page; no second face. Extracted from https://qonto.com/fr [live]. Third-party claims (72/56/18/12 px scale, 24 px / 8 px radii) [3rd: https://www.shadcn.io/design/qonto, unverified].
- **Colour.** Page CSS exposes `--bg-color: #1A1A1A` with white borders/glow for the dark sections; the page references "Iconography Black" and dark-mode badge variants, i.e. mono icon set and themed badges. [live, page content]
- **Density.** "Bento" and "Headline Cards" labels in the page's own asset names: modular card grid. [live]
- **Money.** Amounts appear only in copy (account remuneration up to 5 %, card limits up to €200,000); no amount-rendering rules visible. [live]
- **Provenance.** Relevant precedent: the AI section promises "you review & approve" and "logged, traceable actions", i.e. machine work is shown as a proposal awaiting a human decision. [live, qonto.com/en]
- **Guest / email.** Not a guest. [n/a]
- **Accessibility.** Not published. [unverified]
- **Public system.** None; a 2023 article says Qonto standardised on Figma/FigJam internally. https://www.digidop.com/fr/blog/qonto-optimise-process-design-grace-integration-figma-figjam [3rd].
- **Take.** One typeface, two weights, done; the "proposal awaiting approval" framing for machine output. **Avoid.** Nothing specific; too little is public to copy a system.

### 1.5 GOV.UK Design System

- **What / who.** The UK state's service design system; citizens of every ability on every device. https://design-system.service.gov.uk/ [live].
- **Typography.** GDS Transport is mandatory on `service.gov.uk` and licensed only to GOV.UK-family domains; everyone else is told to use an alternative (the 2015 design-notes post names Arial; the typeface page points to "use GOV.UK Frontend without GOV.UK branding"). Type scale on large screens 80/80, 48/50, 36/40, 27/30, 24/30, 19/25, 16/20 (size/line-height, line-heights in multiples of 5 px); smaller screens step each down (e.g. 48 → 32/35). Tabular figures are an option of the font mixin: `@include govuk-font($size: 19, $tabular: true)`. https://design-system.service.gov.uk/styles/typeface/ , https://design-system.service.gov.uk/styles/type-scale/ [live]; https://designnotes.blog.gov.uk/2015/03/11/can-i-use-the-gov-uk-fonts [live, 2015 post].
- **Colour.** Text `#0b0c0c`, secondary `#484949`; links `#1a65a6` / hover `#0f385c` / visited `#54319f`; focus `#ffdd00` with `#0b0c0c` text and *only* for focus; error `#ca3535`, success `#0f7a52`; WCAG 2.2 SC 1.4.3 AA required; colours only via Sass functions, never hardcoded. No dark mode. https://design-system.service.gov.uk/styles/colour/ [live].
- **Density.** Large type, single column, generous line-height; one thing per page (service manual principle).
- **Money.** Not a money system; numbers rely on the tabular option above.
- **Provenance / status.** The Tag component: "Keep the number of statuses small", adjectives not verbs, never interactive, never colour alone, sentence case and regular weight (uppercase bold was dropped because research found it harder to read; dark tags were lightened because users tried to click them). https://design-system.service.gov.uk/components/tag/ [live].
- **Guest / email.** Not a guest; GOV.UK Notify emails are plain text by policy (not re-verified here). [unverified]
- **Accessibility.** The strongest posture in this survey: AA is a hard rule, focus colour is reserved, tags carry text. [live]
- **Public system.** Yes: https://design-system.service.gov.uk/ (styles, components, patterns, research notes per component).
- **Take.** Reserved focus colour; tags in sentence case, light background, dark text, always with words; line-heights on a 5 px grid; "fewest statuses that work". **Avoid.** 19 px body and 80 px headings on a 320 px chat card; the font is not licensable anyway.

### 1.6 DSFR, Système de Design de l'État (France)

- **What / who.** The French state's design system, restricted to administrations on `.gouv.fr`: "ne doit pas être utilisé par des entités extérieures à l'administration". https://github.com/GouvernementFR/dsfr [live, README].
- **Typography.** Marianne 400/500/700 with `arial, sans-serif` fallback; Spectral 400/900 with `georgia, serif` fallback; `.fr-h1` 2 rem / 2.5 rem, `.fr-h2` 1.75 rem / 2.25 rem, `.fr-text--sm` 0.875 rem / 1.5 rem. No `tabular-nums` anywhere in the 728 KB bundle. Extracted from `@gouvfr/dsfr@1.15.4/dist/dsfr.min.css` via unpkg [live]. State brand rule that Spectral is an accompanying face to use "avec parcimonie" for quotes, translations and secondary matter, Marianne always preferred: https://www.info.gouv.fr/marque-de-letat/la-typographie (page returned 403; wording seen only through search snippets) [unverified].
- **Colour.** Tokens are named by hue and lightness pair and flip per theme: `--blue-france-sun-113-625` is `#000091` in light and `#8585f6` in dark; text `--text-default-grey: var(--grey-200-850)`, mention `--grey-425-625`, borders `--grey-900-175`; status `--text-default-info/success/warning/error` all resolve to `*-425-625` tokens. Dark mode via `data-fr-scheme="system|light|dark"` on `<html>` (48 `[data-fr-theme=dark]` rule blocks). [live, same CSS and README]
- **Density.** Spacing on multiples of 4 px with documented exceptions (−6, −2, 2, 6 px); body 16/24, article text 18/28. https://open-design.ai/design-system-assets/DESIGN-dsfr.md [3rd].
- **Money.** None.
- **Provenance.** The two-face rule is itself a provenance device: Spectral marks quoted, translated or historical matter; Marianne is the state's own voice. [unverified wording, see above]
- **Guest / email.** Not a guest. Accessibility docs reportedly flag insufficient hover contrast in dark theme [3rd, open-design.ai].
- **Accessibility.** RGAA is the legal frame for French public sites; the README itself does not name it. [live README; RGAA link unverified]
- **Public system.** Yes, https://www.systeme-de-design.gouv.fr/ (403 to automated readers on 21 Oct 2026; source on GitHub and npm is open under Etalab 2.0, fonts excluded).
- **Take.** The light/dark *pair* naming (`hue-lightnessLight-lightnessDark`) so every token has its dark twin by construction; a second face reserved for *other people's words*. **Avoid.** Spectral as our human voice (it is the French state's quotation face; the association is strong in France); the system is not licensable.

### 1.7 Linear

- **What / who.** Issue tracking for software teams; the reference for dense, quiet, keyboard-first SaaS. https://linear.app/brand [live].
- **Typography.** Serves `InterVariable.woff2` from static.linear.app; the March 2024 redesign post states Inter Display for headings and Inter for everything else. https://linear.app [live, HTML]; https://linear.app/blog/how-we-redesigned-the-linear-ui [live]. Third-party details (weights 300/510/590, `cv01`/`ss03`, Berkeley Mono) [3rd, unverified].
- **Colour.** Brand page: a desaturated blue reserved for backgrounds, "Mercury White" `#F4F5F8`, "Nordic Gray" `#222326`, monochrome wordmarks preferred. Redesign: themes generated in LCH from three variables (base colour, accent, contrast) instead of 98 hand-set ones; text and neutral icons made darker in light / lighter in dark; a contrast variable yields automatic high-contrast themes. [live, both pages]
- **Density.** Explicit goal: "increase the hierarchy and density of navigation elements", reduce visual noise, keep alignment consistent; "Linear relies on a set of structured layouts that support the navigation elements and content." [live, redesign post]
- **Money.** None.
- **Provenance.** Not a visual device; Linear is single-origin.
- **Guest / email.** Linear is a host, not a guest. Notification emails were not verified (Really Good Emails has no Linear entry readable by automation). [unverified]
- **Accessibility.** The contrast variable and auto high-contrast themes are the published posture. [live]
- **Public system.** Brand page only (logo, colours, naming); no component or token documentation.
- **Take.** Generate both themes from a small set of variables in a perceptual space (LCH/OKLCH), as our brainstorm §4 already proposes; density through alignment, not through smaller type. **Avoid.** Near-black indigo canvases as a default: the chat hosts we live in are warm off-white (Claude) or neutral (ChatGPT, Cursor).

### 1.8 Apple Wallet passes

- **What / who.** Signed, portable proof-of-something that the system renders; issuers get fields and colours, never layout. https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html [live, archive guide].
- **Typography.** System font; the issuer sets no type at all (the "no custom fonts" rule is widely known but not confirmed in the fetched page) [unverified]. Back fields shrink as content grows.
- **Colour.** Exactly three keys: `backgroundColor`, `foregroundColor` (values), `labelColor` (labels), as `rgb()` strings. [live]
- **Density.** Fixed slots: header ≤3 (only visible when stacked), primary 1 (2 on boarding passes), secondary ≤4, auxiliary ≤4; "Do not include more fields than are displayed on the front of your pass." [live]
- **Money.** Values are formatted by the system, not the issuer: `currencyCode`, `numberStyle` (e.g. `PKNumberStyleSpellOut`), `dateStyle`/`timeStyle`, `isRelative`, so locale is always right. [live]
- **Provenance.** The whole object is signed (`manifest.json` of hashes + detached signature); back-of-pass contact information for the signing organisation is required; "Don't try to manipulate the pass's presence on the lock screen by providing inaccurate relevance information." [live]
- **Guest / email.** The pass *is* a guest in the OS; it owns colour and content only.
- **Accessibility.** System-rendered, so Dynamic Type and VoiceOver come for free. [general knowledge, unverified on page]
- **Public system.** Yes: PassKit docs + Human Interface Guidelines (https://developer.apple.com/design/human-interface-guidelines/wallet, JavaScript-only, not readable by automation).
- **Take.** Label/value pairs with a *label colour* distinct from the value colour; let the renderer format money and dates per locale; a signed object with mandatory issuer contact: this is the closest existing metaphor to an attested answer. **Avoid.** Pass-like skeuomorphism (strips, hole-punches); the metaphor is in the structure, not the look.

### 1.9 Prolific (participant side)

- **What / who.** Paid research participants, the closest existing "public as sensors" marketplace. https://www.prolific.com/participants [live].
- **Typography.** Serves a single family "New Hero" (Regular/Medium/SemiBold) on the marketing site. Extracted from https://www.prolific.com HTML [live]. The participant app itself was not inspected. [unverified]
- **Colour.** Not extractable from the fetched content. [unverified]
- **Density.** Studies page lists eligible studies; "Start now" opens the external study. https://participant-help.prolific.com/en/articles/445003-what-is-prolific-and-how-does-it-work [live].
- **Money.** The clearest money ethics in the survey: cash only ("no gift cards or cashback"); hard floor £6/$8 per hour, recommended £9/$12; participants see *both the intended and the actual* hourly rate, the actual one computed from median real completion time; underpaying studies trigger a 22-day adjustment window; "Report study" button; PayPal cash-out, $6/£6 minimum. https://participant-help.prolific.com/en/articles/445043-underpaying-studies , https://researcher-help.prolific.com/en/articles/445239-what-is-your-pricing , https://www.prolific.com/participants [live].
- **Provenance.** Trust signalled with institutional proof (Oxford 2014 origin, ISO 27001 logo, "built by researchers for researchers"). [live]
- **Guest / email.** Invitations arrive on the Studies page, a browser extension and "occasionally by email". [live]
- **Accessibility.** Not published. [unverified]
- **Public system.** None.
- **Take.** Show promised *and* realised rate side by side; make "report this" a first-class control; money in cash terms, never credits. **Avoid.** Marketing-site exuberance ("Earn money. Have fun.") on a surface whose user did not ask to be there (PRD §2: "no tolerance for spam").

### 1.10 Cal.com

- **What / who.** Open-source scheduling whose booking page is embedded in other people's sites, i.e. a guest by design. https://cal.com [live].
- **Typography.** Marketing site loads Cal Sans (Google Fonts), Inter, Fragment Mono and Manrope via Framer; the app's faces were not inspected. [live for marketing; app unverified]
- **Colour.** Brand colour settable *separately for light and dark*; theme Light / Dark / System (default System). https://cal.com/help/quick-start/customization , https://cal.com/docs/core-features/customization [live]. A `color-tokens` white-labelling page redirects elsewhere and could not be read. [unverified]
- **Density.** Booking page is a single task; not studied further.
- **Money.** Paid bookings exist but their rendering was not inspected. [unverified]
- **Provenance.** None.
- **Guest / email.** "If you update the theme and brand colours to match your website, the embed looks like part of your site." Embed API accepts `theme` light/dark/auto and `styles.branding.brandColor`; per-theme CSS variables via `cssVarsPerTheme` (seen on a documentation mirror) [3rd: https://mintlify.com/calcom/cal.com/embed/customization].
- **Accessibility.** Not published. [unverified]
- **Public system.** Source is public (https://github.com/calcom/cal.com); no design-system site.
- **Take.** Two brand colours (one per theme) rather than one brand colour forced into both; `auto` theme as default. **Avoid.** Nothing specific.

### 1.11 Claude MCP Apps (host guidelines for third-party cards)

- **What / who.** The rules our principal-side card must obey inside Claude. https://claude.com/docs/connectors/building/mcp-apps/design-guidelines , https://claude.com/docs/connectors/building/mcp-apps/transparent-theming [live].
- **Typography.** Host provides `--font-sans: "Anthropic Sans, sans-serif"` (served from assets.claude.ai) and `--font-mono: ui-monospace, monospace`; sizes `text-xs/sm/md/lg` 12/14/16/20 px, headings 12 → 36 px; weights 400/500/600/700. Rule: "Stick to the three-level size scale of heading, body, and caption, and the two weights of regular and emphasized." [live]
- **Colour.** Warm neutrals: backgrounds `#FFFFFF / #F5F4ED / #FAF9F5` light, `#30302E / #262624 / #141413` dark; text `#141413 / #3D3D3A / #73726C` light, `#FAF9F5 / #C2C0B6 / #9C9A92` dark; borders are alpha (`#1F1E1D` at 40/30/15 %); semantic info/danger/success/warning each as background/text/border/ring tokens (e.g. success text `#265B19` light, `#7AB948` dark). Rule: "Use host tokens for all structural elements: backgrounds, text, borders, and icons. You can use your own brand colors for accents and identity." Values use CSS `light-dark()`. [live]
- **Density.** Inline card: height auto-fits, no nested scrolling, at most 2 actions at the bottom, at most 4–5 data points, no menus or popovers, 44 pt targets, 320 px minimum width; radii 4/6/8/10/12 px; `border-width-regular: 0.5px`; shadows hairline → lg. Skeletons, not spinners. [live]
- **Money.** None specified.
- **Provenance.** Not addressed; the host marks tool output as a card, nothing more. Our human-origin turn must carry its own marking inside those tokens.
- **Guest / email.** Background must stay transparent ("every frame between your widget and the chat surface already has a transparent background"); `prefersBorder: false`; `color-scheme: light dark` meta; `hostContext.theme` and `hostcontextchanged` events; CSP must allowlist `https://assets.claude.ai` for the host font. [live]
- **Accessibility.** WCAG AA minimum, keyboard navigation, text alternatives, 44 pt. [live]
- **Public system.** Yes: the guideline pages above plus a Figma kit (https://www.figma.com/community/file/1597641111449594397/mcp-apps-for-claude).
- **Take.** Everything structural from host tokens, identity only in accents; three sizes, two weights; ≤2 actions and ≤5 data points per card. **Avoid.** Any opaque card background or own font on this surface.

### 1.12 ChatGPT Apps SDK (host guidelines)

- **What / who.** Same role for ChatGPT. https://developers.openai.com/apps-sdk/concepts/design-guidelines [live].
- **Typography.** "Don't use custom fonts, even in full screen modes." System fonts only. [live]
- **Colour.** System colours for text, icons, dividers; brand accents only on icons, badges and primary buttons; no colour on text-area backgrounds; "Avoid custom gradients or patterns that break ChatGPT's minimal look." Theme handling not documented. [live]
- **Density.** Inline card for a single action or a small amount of data; "Support up to two actions maximum, with one primary CTA and one optional secondary CTA"; no deep navigation, no nested scrolling. [live]
- **Money.** None.
- **Provenance.** "Do not include your logo as part of the response"; ChatGPT appends the app's logo and name before the widget. Authorship of the card is therefore the host's job; authorship of the *content* is ours. [live]
- **Guest / email.** Display modes inline / fullscreen / PiP. [live]
- **Accessibility.** WCAG AA contrast, alt text, text resizing without breaking layout. [live]
- **Public system.** Guidelines only.
- **Take.** The two-CTA rule and "brand only on icon, badge, primary button" read as the common denominator with Claude; design to that denominator once. **Avoid.** Relying on the host to mark human origin: neither host does.

### 1.13 Slack Block Kit

- **What / who.** JSON layout language for apps inside Slack; the most mature "third-party card inside chat" precedent. https://docs.slack.dev/block-kit/ , https://docs.slack.dev/reference/block-kit/blocks [live].
- **Typography / colour.** Apps control neither fonts nor colours in blocks. The only colour ever offered was the legacy attachment `color` left border (`good`, `warning`, `danger` or hex), which Slack now says "should be avoided in nearly every case". https://docs.slack.dev/legacy/legacy-messaging/legacy-secondary-message-attachments [live].
- **Density.** 50 blocks per message; section text ≤3000 chars, ≤10 fields of ≤2000 chars rendered in two columns; header, context, divider, actions, plus 2026 agent-era blocks (alert, container, card, carousel, data table, plan, task card). https://docs.slack.dev/reference/block-kit/blocks/section-block [live].
- **Money / provenance.** Nothing beyond text; `context` blocks (small text + 16 px icon) are the idiom for "who/when" metadata.
- **Guest / email.** Pure guest; screen readers read the top-level `text` fallback, not the blocks, so the fallback must carry the whole meaning. [live]
- **Accessibility.** Host-owned; the fallback-text rule is the app's one duty. [live]
- **Public system.** Yes (docs + Block Kit Builder).
- **Take.** Write the text fallback first; it is also what a terminal host will show (PRD §6.4). Treat "context" (small, muted, with a tiny avatar) as the universal metadata idiom. **Avoid.** Coloured side bars as status: Slack itself retired them.

### 1.14 Discord Components V2 and Intercom Canvas Kit (other hosts)

- **Discord.** Container exposes one visual knob, `accent_color` (integer RGB); Text Display is markdown; ≤40 components per message; embeds cap at title 256 / description 4096 / 25 fields / 6000 total, 10 embeds. No fonts, no text colours. https://docs.discord.com/developers/components/reference , https://docs.discord.com/developers/resources/message [live].
- **Intercom.** Text styles are an enum (`header`, `paragraph`, `muted`, `error`), buttons `primary`/`secondary`/`link`, markdown limited to links and bold; colour, weight and size "cannot be edited through Markdown" and come only from `style`. https://developers.intercom.com/docs/references/canvas-kit/presentationcomponents/text , https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button [live].
- **Take.** Across four hosts the third-party vocabulary converges on: one accent, one muted text role, one error role, ≤2 buttons, markdown-ish text. A2H's card semantics must be expressible in that vocabulary or they will not survive the hop.

### 1.15 Vercel Geist

- **What / who.** Vercel's public design system for developer tools; the current reference for monochrome, grid-led, mono-friendly UI. https://vercel.com/geist/introduction [live].
- **Typography.** Geist Sans and Geist Mono (SIL OFL; "simplicity, minimalism, and speed", Swiss influence). Classes by role: `text-heading-72 … 14`, `text-button-16/14/12`, `text-label-20 … 12`, `text-copy-24 … 13`, with `Strong`/`Subtle` modifiers via `<strong>`, and mono variants `text-label-14/13/12-mono`, `text-copy-13-mono` for inline code; Label 13 notes tabular figures for numbers. https://vercel.com/geist/typography , https://vercel.com/font [live].
- **Colour.** Ten scales × ten steps (`gray`, `gray-alpha`, `blue`, `red`, `amber`, `green`, `teal`, `purple`, `pink`, plus `backgrounds`) with fixed step roles: 100 default bg, 200 hover bg, 300 active bg, 400 default border, 500 hover border, 600 active border, 700 high-contrast bg, 800 its hover, 900 secondary text/icons, 1000 primary text/icons; `gray-alpha` for anything that must let the background through. P3 on capable displays. https://vercel.com/geist/colors [live].
- **Density.** Grid "a core part of the Vercel aesthetic"; materials page for radii, fills, strokes, shadows. [live, introduction]
- **Money / provenance.** None.
- **Guest / email.** Not a guest.
- **Accessibility.** "designed for accessible text and icons" (steps 9–10); no contrast table published on the colours page. [live]
- **Public system.** Yes: https://vercel.com/geist/introduction (and `@vercel/geistcn`).
- **Take.** The step-role contract (which step is a border, which is text) and alpha grey for guest surfaces; a label-size mono for ids, hashes and signatures. **Avoid.** Geist's near-total absence of warmth: our participant surface is a person's phone, not a deploy log.

### 1.16 iA Writer

- **What / who.** Writing app whose whole design is "nothing competes with your words"; the one mainstream product that *visually marks who wrote what*. https://ia.net/writer [live].
- **Typography.** Custom families iA Writer Mono, Duo and Quattro, "modified versions of IBM Plex" (Duo is a duospace: wide letters take two cells). https://github.com/iaolo/iA-Fonts [live].
- **Colour.** Functional only: syntax highlight for parts of speech; Focus Mode fades everything but the current sentence or paragraph. [live]
- **Density.** "No buttons, no popups, no title bar." [live]
- **Money.** None.
- **Provenance.** Authorship: human text in "subtle tones", AI-attributed text "shown with a colorful gradient", reference material "dimmed"; "Your own words speak in black and white"; attribution is assigned by the user (Mark Selection / Paste As / Paste Edits From), runs locally, "does not modify your content in anyway". https://ia.net/writer/support/editor/authorship [live].
- **Guest / email.** Not a guest.
- **Accessibility.** Not documented. [unverified]
- **Public system.** Fonts are public; no UI system.
- **Take.** The inversion is the lesson: the *human* voice is plain black-and-white and the *machine* voice is what gets the colour. A2H can make the human answer the typographically neutral, unmistakably "set" text and reserve tint for agent/platform chrome, which also solves the "same serif for both origins" fault in our prototypes. **Avoid.** Gradients as a marker on a 320 px card in a host that forbids gradients (§1.12).

---

## 2. Comparison matrix

Scale: ● strong and documented · ◐ partial or implied · ○ weak, absent or not applicable. Column "Provenance" = visual distinction of who speaks (human / system / quoted). "Guest" = how well it behaves inside a UI it does not own.

| Reference | Type discipline | Numbers & ids | Colour discipline | Dark mode | Density fit for a 320 px card | Money rendering | Provenance | Guest | Email | A11y posture | Public system |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.1 Stripe | ● | ◐ | ● | ◐ (host-driven) | ◐ | ● | ○ | ● | ● | ● | ◐ (docs + Figma) |
| 1.2 Wise | ● | ● (tnum) | ● | ● | ○ | ● | ○ | ○ | ◐ | ◐ | ◐ (site unreadable) |
| 1.3 Mercury | ◐ (proprietary) | ◐ | ● | ● | ◐ | ● | ○ | ○ | ○ | ○ | ○ |
| 1.4 Qonto | ● (one face) | ○ | ◐ | ◐ | ◐ | ◐ | ◐ (review & approve) | ○ | ○ | ○ | ○ |
| 1.5 GOV.UK | ● | ● | ● | ○ | ○ | ○ | ◐ (tags) | ○ | ◐ | ● | ● |
| 1.6 DSFR | ● | ○ (no tnum) | ● | ● | ○ | ○ | ◐ (Spectral for quotes) | ○ | ○ | ● | ● (not licensable) |
| 1.7 Linear | ● | ◐ | ● | ● | ● | ○ | ○ | ○ | ○ (unverified) | ◐ | ○ (brand page) |
| 1.8 Apple Wallet | ◐ (system font) | ● (locale formatting) | ◐ (3 keys) | ● | ● | ● | ● (signed, issuer contact) | ● | ○ | ● | ● |
| 1.9 Prolific | ◐ | ◐ | ○ | ○ | ◐ | ● (intended vs actual rate) | ◐ | ○ | ◐ | ○ | ○ |
| 1.10 Cal.com | ◐ | ○ | ◐ | ● (brand per theme) | ◐ | ○ | ○ | ● | ○ | ○ | ◐ (source) |
| 1.11 Claude MCP Apps | ● | ◐ (mono token) | ● | ● | ● | ○ | ○ | ● | ○ | ● | ● |
| 1.12 ChatGPT Apps | ● (system fonts) | ○ | ● | ◐ | ● | ○ | ◐ (host appends logo) | ● | ○ | ● | ◐ |
| 1.13 Slack Block Kit | ○ (none) | ○ | ○ (none) | ● (host) | ● | ○ | ◐ (context block) | ● | ○ | ◐ (fallback text) | ● |
| 1.14 Discord / Intercom | ○ | ○ | ○ (one accent) | ● (host) | ● | ○ | ○ | ● | ○ | ◐ | ● |
| 1.15 Geist | ● | ● (mono labels, tabular) | ● | ● | ● | ○ | ○ | ○ | ○ | ◐ | ● |
| 1.16 iA Writer | ● | ○ | ● | ● | ○ | ○ | ● | ○ | ○ | ○ | ◐ (fonts only) |

Reading the matrix: nobody scores on all of money, provenance and guest behaviour at once. Money is solved by fintech (1.1–1.3, 1.9), provenance by a signed object (1.8) and a writing tool (1.16), guest behaviour by the hosts themselves (1.11–1.14). A2H's identity has to be the intersection, which is why none of the single references can be copied.

---

## 3. Five patterns that recur across the best references, and that A2H should adopt

1. **Structure from the host, identity in one or two accents.** Claude, ChatGPT, Slack, Discord and Intercom all say the same thing in different words: backgrounds, text, borders and icons come from the host; the app may colour an icon, a badge and the primary button, nothing else (1.11, 1.12, 1.13, 1.14). Stripe's Appearance API is the same contract seen from the other side (1.1). Our card should be designed *first* as host tokens plus two A2H roles (agent accent, human marker), and the dashboard/PWA should inherit from that, not the reverse.
2. **Semantic status as a bg/border/text triplet, in sentence case, always with words.** Stripe's badge variables (1.1), Claude's `color-background/text/border-{info,danger,success,warning}` (1.11), Wise's positive/negative/warning ladders (1.2) and GOV.UK's tag research (1.5: light background, dark text, regular weight, never colour alone, "fewest statuses that work") converge. PRD statuses `sent → accepted → answered | declined | expired | cancelled` map to at most four hues plus neutral.
3. **Numbers are set apart: tabular figures, locale formatting done by the renderer, one small mono role for ids and signatures.** Wise forces `tnum` wherever a number animates (1.2), GOV.UK exposes `$tabular` (1.5), Geist gives Label 13 tabular figures and a mono label size for ids (1.15), Wallet refuses to let the issuer format money at all (`currencyCode`, `numberStyle`) (1.8). DSFR, which ships no tabular setting, is the counter-example (1.6). For A2H: money in tabular sans with its verb (held / cleared / returned / paid out), request ids and Ed25519 signatures in a 12–13 px mono.
4. **Both themes generated from a few variables in a perceptual space, with alpha neutrals for anything that touches someone else's surface.** Linear's three-variable LCH themes (1.7), DSFR's paired `light/dark` lightness names (1.6), Mercury's alpha borders and focus rings (1.3), Geist's `gray-alpha` scale (1.15) and Claude's alpha `color-border-*` (1.11). Our brainstorm §4 already proposes OKLCH derivation; this survey confirms it is the industry norm and adds: borders and dividers must be alpha, never solid, because the card's background is not ours.
5. **The human voice is plain; the machine voice carries the colour; the whole thing is signed and the signer is reachable.** iA Writer's inversion (1.16: "Your own words speak in black and white", AI gets the gradient), Wallet's signed manifest with mandatory issuer contact (1.8), Qonto's "you review & approve, logged, traceable" framing for machine output (1.4), and Prolific's promised-vs-actual rate shown side by side (1.9). For A2H this means: the participant's answer is the most *typographically neutral* element on the principal's screen (high-contrast text, generous measure, no tint), while agent drafts, platform notes and status chrome are the tinted elements; attestation, signature and timestamp sit under the answer in the mono role, with the principal's identity disclosure and the participant's verification state stated in words.

---

## 4. Three references the owner should open first

1. **Claude's MCP Apps design guidelines** (host tokens, display modes, "three sizes, two weights", ≤2 actions): https://claude.com/docs/connectors/building/mcp-apps/design-guidelines (read 21 Oct 2026), with the Figma kit https://www.figma.com/community/file/1597641111449594397/mcp-apps-for-claude. Why first: it is the surface the principal actually sees, the constraints are non-negotiable, and the palette (warm `#F5F4ED`/`#FAF9F5` paper, `#141413` ink) is already closer to our participant "warm paper" than to our principal "cool slate", which questions the two-neutral-palette decision in the skill.
2. **Stripe Connect embedded components appearance options**, with the live customisation preview: https://docs.stripe.com/connect/embedded-appearance-options.md and https://docs.stripe.com/connect/customize-connect-embedded-components (read 21 Oct 2026). Why: it is the most complete public spec of how a money UI stays recognisably itself while taking the host's font, radius, spacing and colours, including the four-state badge triplets; the preview lets the owner move `spacingUnit`, `borderRadius` and `colorPrimary` and watch what a ledger row does.
3. **iA Writer Authorship** support page and product page: https://ia.net/writer/support/editor/authorship and https://ia.net/writer (read 21 Oct 2026). Why: it is the only shipping precedent for marking who wrote which words, and its choice (human = plain, machine = coloured) is the opposite of our prototypes' ochre-tinted human card; the owner should decide which way round A2H goes before any palette work.

Runner-up: Apple's PassKit design guide for the "signed object with fixed slots and issuer-independent money formatting" structure: https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html (read 21 Oct 2026).

---

## 5. Not verified, dropped, or blocked

- **Malt** (French freelance marketplace): https://www.malt.com and https://www.malt.fr returned a 403 / bot wall on 21 Oct 2026; no brand or design page found via search (results were job postings). Not in the matrix. [unverified]
- **DSFR official site** https://www.systeme-de-design.gouv.fr/ and https://www.info.gouv.fr/marque-de-letat/la-typographie: 403 to automated readers; facts above come from the GitHub README and the published npm CSS, the "parcimonie" wording from search snippets only.
- **Wise Design docs**: wise.design is JavaScript-only and docs.wise.design redirects to a 404 (21 Oct 2026); tokens were taken from wise.com's served CSS instead. Third-party hex values for Wise differ between sources (e.g. `#87ea5c` vs `#9fe870`); the live CSS says `#9fe870`.
- **Mercury typography specifics** (weights, tracking) and **Linear's accent hex / Berkeley Mono**: third-party only; font *files* were verified live, metrics were not.
- **Apple HIG Wallet page** and **Anthropic brand typography page** (https://brand.anthropic.com/typography): JavaScript-only; Anthropic Sans/Serif names come from the Claude MCP Apps guidelines.
- **Really Good Emails**: no Stripe, Linear or Notion receipt/notification entries were readable (search and category pages returned navigation only, 21 Oct 2026). Stripe receipt facts come from Stripe's own docs. Linear/Notion notification emails: not surveyed. [unverified]
- **Cal.com colour tokens page** redirected off-domain; embed theming details come from a documentation mirror. [3rd]
- **Prolific participant app** visuals: only help-centre text was read; no screenshots inspected. [unverified]
- Not surveyed for lack of time or public material: Monzo, Revolut, Lydia, Pennylane, Brex, Ramp, Docusign, Notion, Upwork, Intro.co, Clarity.fm, Fiverr, Airbnb, Superpeer, Cursor/Codex card rendering, Readwise, Substack, Arc, Things 3, Teenage Engineering. Cursor and Codex matter for PRD §6.4 and should be checked against the MCP Apps host list (ext-apps README lists ChatGPT, Claude, VS Code, Goose, Postman, MCPJam, mcp-use, Alpic as hosts, 21 Oct 2026: https://github.com/modelcontextprotocol/ext-apps) once their rendering is observable.
