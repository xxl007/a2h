# Survey: implementation-ready design systems A2H could adopt

Status: research for a product-owner decision, not a decision. Prepared by the Design agent, 21 October 2026. Track: **implementation-ready systems** (a token system plus a maintained React component library usable with Next.js App Router). Nothing here changes `packages/ui`, the a2h-design skill or the prototypes; a chosen base would be recorded in an ADR and skill §2–§3 rewritten from it.

How to read this: §1 restates the criteria as they fall out of the PRD; §2 lists every candidate looked at and who fell at the first cut and why; §3 has one record per surviving system; §4 is the score table and ranking; §5 the shortlist with what A2H would take and the risk; §6 the embedded-card references; §7 open questions. Every factual claim carries the URL it was read from; "fetched 2026-10-21" applies to all of them unless stated. Facts I could not confirm on a live page are marked **unverified**. Aesthetic judgements are mine and marked as such.

## 1. What A2H needs from a design system

Derived from `docs/PRD.md` §2, §6, §7, §11 and `CLAUDE.md` (engineering rules), restated as the ten scoring criteria used in §4:

| # | Criterion | Why (source) |
|---|---|---|
| 1 | WCAG 2.2 AA out of the box, keyboard-complete components, 44 px touch targets on mobile | PRD §11 "WCAG 2.2 AA on PWA and dashboard"; CLAUDE.md "44px targets on the PWA, reduced-motion respected" |
| 2 | Layered tokens (primitive → semantic → component), light and dark themes, documented contrast guarantees, ideally OKLCH/perceptual scales | skill §2 and §7 (contrast measured per pair; light `--pend` fails today); dark mode inherited by three different paths (OS, host, mail client) |
| 3 | Strong typography defaults and a documented type scale, not a thin wrapper around Tailwind | skill §2.3; the brainstorm audit found fifteen ad-hoc sizes in the prototypes |
| 4 | Works for three surfaces: phone PWA (forms, segmented controls, large targets), data-dense dashboard (tables, status pills), and a small card embedded in someone else's chat UI (themeable to the host, small footprint, no global reset leakage) | PRD §6.4 MCP App card, §6.7 ledger, §7.4–7.6 request page and answer form |
| 5 | An email story, or at least tokens exportable to inline styles | skill §8 "tokens inlined at build time from `packages/ui`"; `packages/email` is React Email |
| 6 | React + TypeScript, server-components friendly, tree-shakeable, small CSS footprint | CLAUDE.md stack: Next.js App Router, server actions; PRD §11 request page under 2 s on 3G |
| 7 | Permissive licence (MIT/Apache-2.0) | we ship it to third-party hosts and in email; no copyleft or brand-use conditions |
| 8 | Maturity: real products on it, active maintenance in 2025–26, Figma library | a small team cannot carry an abandoned base |
| 9 | Aesthetic quality in its own demos and in named products; distinctiveness (not the 2024–26 "AI default" look) | product-owner feedback on the rejected brainstorm |
| 10 | Ease of re-skinning into our brand (own fonts, warm neutral, teal/ochre origin hues) while keeping the engineering | skill §3: teal = agent/platform, ochre = human, never inverted |

Scoring is 1–3 per criterion (3 = meets it as shipped, 2 = meets it with configuration or a known gap, 1 = does not meet it or would need a fork). Criteria 1, 4 and 10 weigh most in the ranking because they are the ones a team cannot fix later without a rewrite.

**Verification note.** Groups "headless/Tailwind" (Radix, shadcn/ui, Base UI, React Aria, Catalyst, Geist, Once UI) and "benchmarks and embedded references" (GOV.UK, USWDS, daisyUI, HeroUI, Stripe, Linear, MCP Apps) were surveyed page by page from live docs on 2026-10-21. For the corporate and independent libraries (Carbon, Primer, Fluent, Atlassian, Polaris, Material, Salesforce, Mantine, Chakra/Ark/Park, Ant Design, Base Web, Garden, Gestalt, Paste, Nord, Cloudscape) the release date, version and licence of every package were read live from `registry.npmjs.org` on 2026-10-21, plus the accessibility, token and licence pages named inline; the remaining fields for those systems come from prior knowledge and are marked **unverified**. Nothing in §4 or §5 rests on an unverified fact.

## 2. Candidates and the first cut

Thirty systems were looked at. A candidate is cut when it fails a criterion that configuration cannot fix (licence, no React path, not maintained, brand-locked, or no accessibility story at all).

| Candidate | Verdict | Reason (URL, fetched 2026-10-21) |
|---|---|---|
| Radix Themes + Colors + Primitives | **survives** | §3.1 |
| shadcn/ui (on Base UI since July 2026) | **survives** | §3.2 |
| Base UI (MUI, headless) | **survives** as substrate | §3.3 |
| React Aria Components (Adobe) | **survives** as substrate | §3.4 |
| Adobe Spectrum 2 (`@react-spectrum/s2`) | cut | Adobe's house style; the `style` macro accepts layout styles only, "colours/padding not customizable" (https://react-spectrum.adobe.com/styling.md); Next.js 16 must run with `--webpack` (https://react-spectrum.adobe.com/getting-started.md). Fails 9 and 10. |
| IBM Carbon | **survives** | §3.5 |
| GitHub Primer | **survives** | §3.6 |
| Microsoft Fluent 2 / Fluent UI React v9 | **survives** (low) | §3.7 |
| Mantine | **survives** | §3.8 |
| Chakra UI v3 / Ark UI / Park UI | **survives** | §3.9 |
| Ant Design 6 | **survives** (low) | §3.10 |
| USWDS | **survives** as accessibility benchmark | §3.11 |
| HeroUI v3 | **survives** (low) | §3.12 |
| Material 3 for web | cut | `@material/web` 2.5.0, published 2026-07-15, Apache-2.0 (registry.npmjs.org/@material/web); it is web components, not React; `@mui/material` 9.5.0 (2026-10-09, MIT) is MUI's own design, not M3. Whether `@material/web` is in maintenance mode: **unverified**. Fails 6. |
| Atlassian Design System | cut | Code packages are Apache-2.0 on npm (`@atlaskit/tokens` 20.6.1, 2026-10-16) but the ADS licence grants use only for add-ons "that interoperate or are integrated with Atlassian's software and cloud products", no derivatives, no redistribution (https://atlassian.design/license). Fails 7 for a standalone product. |
| Shopify Polaris (React) | cut | `@shopify/polaris` 13.9.5 last published 2025-03-26, licence "SEE LICENSE IN LICENSE.md" (registry.npmjs.org/@shopify/polaris); polaris.shopify.com now redirects to shopify.dev, where Polaris is "Shopify's unified UI framework built on web components" for app surfaces (https://shopify.dev/docs/api/polaris). The React package is 19 months stale. Fails 8. |
| Salesforce Lightning (SLDS 2) | cut | `@salesforce/design-system-react` 0.10.65, 2026-01-09, BSD-3-Clause; CSS `@salesforce-ux/design-system` 2.264.1, 2026-08-10. Salesforce-platform look; React port is a 0.x. Fails 9 and 10. |
| Uber Base Web | cut | README: "We are limiting our engagement with this repository while still mirroring our internal development" (https://raw.githubusercontent.com/uber/baseweb/main/README.md); Styletron CSS-in-JS; `baseui` 18.2.0, 2026-07-02, MIT. Fails 8. |
| Zendesk Garden | cut (close) | Apache-2.0, `@zendeskgarden/react-buttons` 9.16.1, 2026-09-25: alive. Cut because it is Zendesk's product look with a small outside ecosystem; Figma kit public: **unverified**. Fails 9/10 relative to survivors. |
| Pinterest Gestalt | cut | `gestalt` 177.0.12, last published 2025-12-09, Apache-2.0; Pinterest-specific components and look. Fails 8 and 10. |
| Twilio Paste | cut | `@twilio-paste/core` 21.5.0, last published 2025-08-25, MIT; Twilio-specific tokens and look. Fails 8 and 10. |
| Nordhealth Nord | cut | `@nordhealth/react` 4.12.46, 2026-10-15, licence "SEE LICENSE IN LICENSE.md"; nordhealth.design states no licence and /license/ is 404; no WCAG claim on the home page; web components (https://nordhealth.design/). Fails 7 until the licence is read from the repo (**unverified**). |
| GOV.UK Design System | benchmark only, cut as base | `govuk-frontend` 6.6.0, 2026-10-15, MIT; WCAG 2.2 AA components since 5.0.0 (https://design-system.service.gov.uk/accessibility/accessibility-strategy/); but GDS Transport may not be used off `service.gov.uk` (https://design-system.service.gov.uk/styles/typeface/), no dark mode (CHANGELOG has no entry), no official React port (`govuk-react` last published 2024-05-13). Fails 4, 6, 10. |
| daisyUI 5 | cut | MIT, 5.7.50 (2026-10-13), 68 CSS-only components, OKLCH themes with radius/size/depth knobs (https://daisyui.com/docs/themes/); no React behaviour, no WCAG claim or keyboard docs found. Fails 1 and 6. Its theme block is still a useful reference for criterion 10. |
| Tailwind Catalyst | cut | Paid Tailwind Plus licence (pricing pages served a login wall, figures **unverified**); 23 components; no token layer, colours baked into `.tsx` (https://catalyst.tailwindui.com/docs). Fails 2 and 7. |
| Vercel Geist | cut | Only the fonts are published (`geist` 1.8.1, 2026-10-16, OFL); `@vercel/geistcn` returns 404 on npm (https://registry.npmjs.org/@vercel/geistcn). Not a shippable library. Fails 6 and 8. |
| Once UI | cut | MIT, `@once-ui-system/core` 2.4.0 and a v3.0.0-beta.0 both published 2026-10-21, 268 stars, no accessibility page in the docs nav (https://docs.once-ui.com/). Fails 1 and 8. |
| Also considered | — | AWS Cloudscape (`@cloudscape-design/components` 3.0.1404, 2026-10-21, Apache-2.0): maintained daily, dashboard-grade, but an AWS-console look, not a candidate for a consumer PWA. Reshaped (`reshaped` 4.2.0, 2026-09-08, MIT, one-colour theming, RSC support claimed, https://reshaped.so/). Untitled UI React (MIT free tier, React Aria + Tailwind, paid Pro, https://www.untitledui.com/react). Tremor (frozen since 2025-01-13). Ariakit (0.4.42, 2026-10-14; licence file not found on GitHub, **unverified**). coss ui / Origin UI (Base UI + Tailwind, AGPL-3.0 default, https://coss.com/ui). |

## 3. Records for the surviving systems

Each record: character · maintainer · licence · last release · components · tokens/theming · accessibility · typography · dark mode · bundle/CSS · Figma · products · demo and docs · email · aesthetic judgement (mine). All URLs fetched 2026-10-21.

### 3.1 Radix Themes (+ Radix Colors, Radix Primitives)

- **Character.** Pre-styled React kit on Radix Primitives, "optimized for fast development, easy maintenance, and accessibility" (https://www.radix-ui.com/themes/docs/overview/getting-started). Maintainer WorkOS. Licence MIT (https://github.com/radix-ui/themes).
- **Releases.** `@radix-ui/themes` 3.3.0, 2026-01-31; unified `radix-ui` primitives 1.8.1, 2026-10-12; `@radix-ui/colors` 3.0.0, 2023-10-02, no release in three years (https://registry.npmjs.org/@radix-ui/colors).
- **Components.** Approx. 50 in Themes (Button, SegmentedControl, Table, DataList, Dialog, Select, Switch, TextField, Badge, Callout…); approx. 30 UI primitives.
- **Tokens.** Three layers in vanilla CSS variables: hue scales `--red-1…12` (+alpha) → semantic `--accent-1…12`, `--gray-*`, `--color-background/-panel-solid/-surface/-overlay`, `--focus-*` → component CSS; `<Theme>` props `accentColor`, `grayColor` (Gray, Mauve, Slate, Sage, Olive, Sand), `radius`, `scaling`, `appearance`; per-component `color` and `highContrast` (https://www.radix-ui.com/themes/docs/theme/color). Contrast guarantee: steps 11 and 12 "guaranteed to meet Lc 60 and Lc 90 APCA contrast on step 2 background of the same scale" (https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale). OKLCH not mentioned; the scales are APCA-tuned sRGB with P3 variants in Themes CSS (**unverified**). Token changes are breaking changes by policy.
- **Accessibility.** Primitives follow WAI-ARIA patterns, manage focus and keyboard, "tested with commonly used assistive technologies" (https://www.radix-ui.com/primitives/docs/overview/accessibility). No WCAG version cited, no audit, no touch-target rule.
- **Typography.** System font stack by default; nine-step scale 12/14/16/18/20/24/28/35/60 px with paired line heights and tracking; fonts via `--default-font-family`, `--heading-font-family`, `--code-font-family` (https://www.radix-ui.com/themes/docs/theme/typography).
- **Dark mode.** `appearance="dark"` or a `dark`/`dark-theme` class; next-themes recommended (https://www.radix-ui.com/themes/docs/theme/dark-mode).
- **Bundle/CSS.** One global stylesheet or split `tokens.css`/`components.css`/`utilities.css`; components tree-shake, CSS does not; styles are scoped under `.radix-themes` but tokens and utility classes are global; docs warn Tailwind preflight strips Radix button backgrounds (https://www.radix-ui.com/themes/docs/overview/styling). No RSC statement found.
- **Figma.** No official kit; an unofficial community file is listed on the resources page (https://www.radix-ui.com/themes/docs/overview/resources).
- **Products.** Primitives case studies: Linear, Vercel, Supabase, CodeSandbox, Liveblocks, Node.js (https://www.radix-ui.com/primitives/case-studies). Themes-specific showcase: none published.
- **Demo / docs.** https://www.radix-ui.com/themes/playground · https://www.radix-ui.com/themes/docs. **Email.** Nothing; Radix Colors ships scales as plain JS objects, usable by an email renderer (https://www.radix-ui.com/colors/docs/overview/usage).
- **Judgement.** The quiet, translucent-panel, system-font look that fed the Linear/Vercel aesthetic; distinctive in colour depth, not in shape. Re-skin cost low to medium: fonts are six variables, two origin hues work out of the box via the per-component `color` prop, but a warm neutral and ochre need custom 12-step scales generated to Radix's step semantics, and leaving the system-font and radius grammar means fighting `components.css`.

### 3.2 shadcn/ui

- **Character.** "A code distribution system": component source copied into the repo by CLI, Tailwind-styled, on Base UI (default since July 2026), Radix or React Aria (https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default). Built by shadcn at Vercel; MIT; CLI `shadcn` 4.22.1, 2026-10-18; 126k stars.
- **Components.** 66 in the docs nav, including new AI-chat items (Message, Attachment, Questionnaire, Trace) (https://ui.shadcn.com/docs).
- **Tokens.** One semantic layer of background/foreground pairs (`--background`, `--card`, `--primary`, `--muted`, `--destructive`, `--ring`, `--chart-1…5`, `--sidebar-*`) in `oklch()`, mapped to Tailwind via `@theme inline`; `--radius` 0.625rem; base colours Neutral, Stone, Zinc, Mauve, Olive, Mist, Taupe; eight named styles and "presets" since April 2026 (https://ui.shadcn.com/docs/theming, https://ui.shadcn.com/docs/changelog/2026-04-preset-commands). No primitive layer, no contrast statement.
- **Accessibility.** Inherited from the base library; no WCAG version, audit or target-size guidance on the docs. **Typography.** None shipped; presets accept a font name; the docs site itself uses Geist. No type scale beyond Tailwind's.
- **Dark mode.** `.dark` class via next-themes (https://ui.shadcn.com/docs/dark-mode/next). **Bundle.** Tailwind v4 utilities + CSS variables; code lives in your tree; depends on Tailwind preflight (global reset, not addressed for embedding); App Router is the primary install path.
- **Figma.** No official kit; four free community kits listed (https://ui.shadcn.com/docs/figma). **Products.** None named on the docs. **Demo.** https://ui.shadcn.com/create · https://ui.shadcn.com/blocks. **Email.** Nothing.
- **Judgement.** This is the 2024–26 "AI default" look (zinc, 10 px radius, Geist/Inter, ring-offset focus); the 2026 styles soften it but a designer still reads "shadcn". Mechanically the cheapest to re-skin (one `:root` block in OKLCH, swap the font variable, own the code); the risk is that geometry and spacing defaults are so pervasive the result stays generic unless those change too.

### 3.3 Base UI (MUI)

- **Character.** Unstyled, tree-shakeable React components "from the creators of Radix, Material UI, and Floating UI" (https://base-ui.com/react/overview/about). MIT; `@base-ui/react` 1.9.0, 2026-10-09, monthly cadence (https://base-ui.com/react/overview/releases).
- **Components.** 37: Accordion, Alert Dialog, Autocomplete, Checkbox (+Group), Combobox, Dialog, Drawer, Field, Fieldset, Form, Input, Menu, Number Field, OTP Field, Popover, Radio Group, Select, Slider, Switch, Tabs, Toast, Toggle (+Group), Tooltip… (https://base-ui.com/react/overview/quick-start). No Table.
- **Tokens / typography / dark mode.** None; zero CSS; state exposed as `data-*` attributes and CSS variables (https://base-ui.com/react/handbook/styling).
- **Accessibility.** WAI-ARIA Authoring Practices; links the WCAG 2.2 focus-appearance understanding doc; keyboard and focus management built in; "tested on a broad spectrum of browsers, devices, platforms, screen readers"; no audit; visible focus styling is yours (https://base-ui.com/react/overview/accessibility).
- **Bundle.** No reset, no CSS, zero leakage; portals need `isolation: isolate` on the root; no RSC statement (shadcn's generated Base UI files are `"use client"`). **Figma / products.** None named. **Demo.** https://base-ui.com/react/overview/quick-start.
- **Judgement.** No look at all, which is the point: the best substrate if the owner wants a design that is ours and nothing inherited. Cost is the full design layer; nothing fights back.

### 3.4 React Aria Components (Adobe)

- **Character.** "Over 50 components with built-in behavior… ready for your styles", accessibility- and internationalisation-first (https://react-aria.adobe.com/). Adobe; Apache-2.0; `react-aria-components` 1.22.1, 2026-10-09.
- **Components.** 61 pages, including Table, Tree, Toast, DateField/Calendar, ColorPicker, NumberField, Virtualizer (https://react-aria.adobe.com/llms.txt).
- **Tokens / typography.** None; default class names `react-aria-ComponentName`, `data-*` states, render props; official Tailwind plugin `tailwindcss-react-aria-components` (https://react-aria.adobe.com/styling).
- **Accessibility.** The strongest evidence of any candidate: follows WAI-ARIA APG; test matrix VoiceOver (macOS Safari/Chrome, iOS), JAWS and NVDA (Firefox, Chrome), TalkBack; cites WCAG 2.2 criteria by name (non-text contrast, target size, focus appearance); recommends hit targets meeting the WCAG "enhanced target size" (no px figure); `data-hovered` suppressed on touch; 30+ locales, RTL (https://react-aria.adobe.com/quality). No third-party audit.
- **Dark mode.** Yours. **Bundle.** No CSS, no reset; starter kits (vanilla CSS, Tailwind), shadcn CLI; components are client components (starters begin with `'use client'`) (https://react-aria.adobe.com/getting-started). **Figma.** None for RAC. **Products.** Adobe's own apps; Untitled UI React, HeroUI v3 and shadcn's `aria` base build on it. **Demo.** https://react-aria.adobe.com/ (component gallery and starter kits). **Email.** Nothing.
- **Judgement.** No aesthetic (good). Re-skin is the full design layer, but `data-*` states and the Tailwind plugin make a warm, two-accent system straightforward, and the behaviour layer is the one most likely to still be maintained in five years.

### 3.5 IBM Carbon

- **Character.** IBM's product design system: dense, grid-driven, square, Plex everywhere. `@carbon/react` 1.119.0, published 2026-10-21, Apache-2.0 (https://registry.npmjs.org/@carbon/react).
- **Components.** Approx. 60 (DataTable with batch actions and expansion, Tag, Notification, Modal, Dropdown, Tabs, ProgressIndicator…) — count **unverified** this session.
- **Tokens.** Colour tokens per theme (White, Gray 10, Gray 90, Gray 100), layering model, type tokens, spacing scale; Sass and CSS custom properties; colour themes "strive to comply with the WCAG 2.1 AA guidelines for contrast" (https://carbondesignsystem.com/guidelines/accessibility/overview/). Not OKLCH (**unverified**).
- **Accessibility.** Components follow the IBM Accessibility Checklist, "based on WCAG AA, Section 508, and European standards"; no WCAG version named for components, no audit on the page, no touch-target figure (same URL).
- **Typography.** IBM Plex Sans/Serif/Mono, open source; 17-step scale 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 54, 60, 68, 76, 84, 92 px; type tokens in a "productive" and an "expressive" set (https://carbondesignsystem.com/elements/typography/overview/).
- **Dark mode.** Via theme (Gray 90/100) applied with `Theme` component or Sass; mechanism details **unverified**. **Bundle.** Sass with global styles, large CSS; RSC statement **unverified**. **Figma.** Official Carbon Figma libraries exist (**unverified** this session). **Products.** IBM Cloud, watsonx and other IBM products (**unverified**). **Demo.** https://react.carbondesignsystem.com/ (Storybook) · https://carbondesignsystem.com/. **Email.** Nothing found.
- **Judgement.** Genuinely distinctive and the best data-dense dashboard reference here, but it is IBM: the no-radius, Plex, grey-layer grammar is the brand. Re-skinning to a warm paper PWA with 44 px targets means fighting the system; take the DataTable ideas, not the kit.

### 3.6 GitHub Primer

- **Character.** GitHub's product system. `@primer/react` 38.42.0, 2026-10-16, MIT; `@primer/primitives` 11.10.0, 2026-07-30, MIT (https://registry.npmjs.org/@primer/react).
- **Components.** Approx. 70 (**unverified**). **Tokens.** `@primer/primitives` provides design tokens "for color, spacing, and typography" (https://primer.style/); base → functional → component layers and eight colour themes including dark dimmed, high contrast and colour-blind variants (**unverified** this session; the primitives Storybook did not render to text). Setup requires `ThemeProvider` and `BaseStyles`, which "set baseline color, font-family, and line-heights across your project", plus a theme CSS import from primitives (https://primer.style/product/getting-started/react/).
- **Accessibility.** Primer's accessibility pages link GitHub's accessibility programme, focus management and keyboard-shortcut guidance; no WCAG version or audit stated on the fetched pages (https://primer.style/accessibility/).
- **Typography.** System stack by default (`BaseStyles` sets `font-family`); Mona Sans optional (**unverified**). **Dark mode.** Theme CSS files and `data-color-mode` attributes (**unverified**). **Bundle.** `BaseStyles.module.css` suggests CSS modules; `BaseStyles` is a global baseline (leaks into a host page). **Figma.** Official Primer Web kit (**unverified**). **Products.** GitHub.com. **Demo.** https://primer.style/product/ · Storybook https://primer.style/react/storybook/ (**unverified**).
- **Judgement.** A mature, well-engineered system whose token model (functional colour roles, high-contrast and colour-blind themes) is worth copying. But everything built with it looks like GitHub, and the components are desktop-first; the PWA case is weak.

### 3.7 Microsoft Fluent 2 / Fluent UI React v9

- **Facts.** `@fluentui/react-components` 9.74.10, 2026-10-19, MIT. "Fluent's components meet or surpass WCAG 2.1 AA standards" (https://fluent2.microsoft.design/accessibility); no touch-target figure on that page. Styling by Griffel (atomic CSS-in-JS) with global and alias tokens and `webLightTheme`/`webDarkTheme` (**unverified** this session; the Storybook did not render to text). Official Figma kits exist (**unverified**). Products: Microsoft 365, Teams (**unverified**).
- **Judgement.** Solid engineering and a real WCAG claim, but the look is Windows 11 and the token names are Microsoft's; re-skinning to a warm, serif-free, two-hue brand is a fight at every component. Low on 9 and 10.

### 3.8 Mantine

- **Character.** Independent full-featured React library; `@mantine/core` 9.7.3, 2026-10-17, MIT (https://mantine.dev/getting-started/). Approx. 100+ components across packages, including SegmentedControl, Table, Badge, Stepper, Notifications, Dates (**count unverified**).
- **Tokens.** Theme object (colors in 10 shades, `primaryShade` per scheme, radius, spacing, fontSizes xs–xl, headings) emitted as CSS variables from the required global `@mantine/core/styles.css`; a Styles API for internal elements; `data-mantine-color-scheme` on `<html>` with `light`, `dark`, `auto` (https://mantine.dev/theming/color-schemes/). Colours are hex; no contrast guarantee documented (**unverified**).
- **Accessibility.** Tagline "Build fully functional accessible web applications"; no formal statement, WCAG version or audit on the getting-started page (same URL). Keyboard behaviour is complete in practice (**unverified**).
- **Typography.** System stack; `fontSizes` and `headings` scales documented (**unverified**). **Bundle.** CSS modules compiled to one global stylesheet (required), PostCSS preset; Next.js App Router template provided; providers are client components. Global stylesheet leaks into a host page. **Figma.** "there are no official Figma or Sketch design files"; four community kits (https://mantine.dev/getting-started/). **Products.** Not listed officially (**unverified**). **Demo.** https://mantine.dev/ (every doc page is a live demo) · https://ui.mantine.dev/ (**unverified**). **Email.** Nothing.
- **Judgement.** Pleasant, neutral, slightly "admin template" by default (blue primary, 8 px radius); not the AI default but not distinctive either. One of the easiest to re-skin (theme object, CSS variables, Styles API), with the widest component coverage for both PWA and dashboard. The cost is a global stylesheet and no a11y documentation to point an auditor at.

### 3.9 Chakra UI v3 / Ark UI / Park UI

- **Facts.** `@chakra-ui/react` 3.37.0, 2026-08-28, MIT; `@ark-ui/react` 5.39.3, 2026-10-05, MIT; `@pandacss/dev` 2.3.0, 2026-10-19, MIT (registry.npmjs.org). Chakra v3 is built on Ark UI (Zag.js state machines); Park UI is Ark UI styled with Panda CSS (**unverified** this session).
- **Tokens.** The best-structured token model surveyed: `theme.tokens` (base) and `theme.semanticTokens` with conditions, e.g. `{ base: "{colors.red}", _dark: "{colors.darkred}" }`; "conditions used in semantic tokens must be an at-rule or parent selector" (https://chakra-ui.com/docs/theming/semantic-tokens, https://chakra-ui.com/docs/theming/tokens). Values are hex in the docs; OKLCH not mentioned; no contrast guarantee.
- **Accessibility.** Ark UI follows WAI-ARIA patterns (**unverified**); no WCAG version or audit found. **Typography.** System stack, documented `fontSizes`/`textStyles` (**unverified**). **Dark mode.** Semantic-token conditions; colour-mode toggling via class with next-themes (**unverified**). **Bundle.** Chakra v3 uses Emotion at runtime (client provider); Park UI + Panda compiles to static CSS at build, zero runtime (**unverified**). **Figma.** Chakra Pro kit (paid, **unverified**); Park UI Figma (**unverified**). **Demo.** https://chakra-ui.com/ · https://park-ui.com/ · https://ark-ui.com/.
- **Judgement.** Chakra's demos are competent and friendly; Park UI's look is shadcn-adjacent. The engineering is the attraction: semantic tokens with conditions and recipes make a two-hue, light/dark, warm system a configuration exercise, and Ark + Panda gives a zero-runtime path. Risk is ecosystem concentration on one small team and Park UI's maintenance (**unverified**).

### 3.10 Ant Design 6

- **Facts.** `antd` 6.6.7, 2026-10-20, MIT. Three-layer Design Token system (seed → map → alias) with light, dark and compact algorithms, CSS-in-JS at runtime (`@ant-design/cssinjs`), `ConfigProvider` scoping (**unverified** this session). Approx. 70 components; excellent Table (**unverified**). Accessibility: WCAG version and audit **unverified**. Official Figma (**unverified**).
- **Judgement.** Powerful for the dashboard, recognisably "Ant" everywhere (blue 6, 6 px radius, dense forms); the PWA would need `antd-mobile`, a second system. Runtime CSS-in-JS and App Router registry setup go against criterion 6. Low on 9.

### 3.11 USWDS (benchmark)

- **Facts.** `@uswds/uswds` 3.14.0, 2026-08-18 (previous 3.13.0 was 2025-05-23, a 15-month gap); public domain (CC0) with OFL fonts (https://raw.githubusercontent.com/uswds/uswds/develop/LICENSE.md). 47 components (https://designsystem.digital.gov/components/overview/). React via third-party `@trussworks/react-uswds` 13.0.0, 2026-10-06, Apache-2.0.
- **Contrast model.** "Each color family has 10 grades"; the difference between two grades is the "magic number": 40+ gives WCAG AA Large Text, 50+ gives AA, 70+ gives AAA; grade 50 passes against both white and black (https://designsystem.digital.gov/design-tokens/color/overview/). This is the clearest published contrast guarantee of any system surveyed.
- **Accessibility.** Targets WCAG 2.1 AA above the Section 508 (2.0 AA) baseline, aims at as many 2.2 criteria as it can; pa11y and axe on every change; an Accessibility Conformance Report "assessed 44 components of USWDS 3.11.0 in March 2025" (https://designsystem.digital.gov/documentation/accessibility/). Touch targets: "Design large, easy-to-select interaction targets", no figure.
- **Typography.** Source Sans Pro body, Merriweather headings, Roboto Mono; Public Sans available; size tokens from 10 to 140 px normalised per typeface (https://designsystem.digital.gov/design-tokens/typesetting/font-size/). **Dark mode.** None. **Figma.** Official "USWDS design kit (beta)" (https://www.figma.com/community/file/1440921849343185329). **Judgement.** Civic-plain and not adoptable (Sass, BEM, no dark mode), but its grade arithmetic is exactly the "step N is text-safe on step M" rule A2H's tokens need.

### 3.12 HeroUI v3

- **Facts.** `@heroui/react` 3.2.6, 2026-09-17; npm says MIT, docs say Apache-2.0, repo branches disagree (https://heroui.com/docs/react/getting-started). 72 React component pages; React Aria Components + Tailwind v4; every token a CSS variable in OKLCH (`--accent: oklch(0.6204 0.195 253.83)`), themes as `[data-theme]` blocks, no provider required (https://heroui.com/docs/react/getting-started/theming). Accessibility "for WCAG compliance" inherited from React Aria, no version or audit. Official Figma kit v3 (https://www.figma.com/community/file/1546526812159103429). No named products.
- **Judgement.** Tasteful Vercel/Linear-adjacent SaaS look, indistinguishable from shadcn output without a custom theme. The RAC-plus-OKLCH-variables architecture is close to what A2H would build itself, but a March-2026 v3, a licence ambiguity and a paid Pro tier are governance smells for a base.

## 4. Scores and ranking

1–3 per criterion as defined in §1. "Weighted" doubles criteria 1, 4 and 10 (the ones a team cannot fix later).

| System | 1 a11y | 2 tokens | 3 type | 4 three surfaces | 5 email | 6 React/RSC | 7 licence | 8 maturity | 9 aesthetic | 10 re-skin | Sum | Weighted |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| React Aria Components | 3 | 1 | 1 | 3 | 1 | 3 | 3 | 2 | 2 | 3 | 22 | **31** |
| Base UI | 2 | 1 | 1 | 3 | 1 | 3 | 3 | 2 | 2 | 3 | 21 | **29** |
| Radix Themes + Colors | 2 | 3 | 2 | 2 | 2 | 2 | 3 | 2 | 2 | 2 | 22 | **28** |
| Mantine | 2 | 2 | 2 | 2 | 1 | 2 | 3 | 2 | 2 | 3 | 21 | **28** |
| Chakra v3 / Ark / Park | 2 | 3 | 2 | 2 | 1 | 2 | 3 | 2 | 2 | 3 | 22 | **28** |
| IBM Carbon | 2 | 2 | 3 | 2 | 1 | 2 | 3 | 3 | 2 | 1 | 21 | 26 |
| GitHub Primer | 2 | 3 | 2 | 2 | 1 | 2 | 3 | 3 | 2 | 1 | 21 | 26 |
| Ant Design 6 | 2 | 3 | 2 | 2 | 1 | 2 | 3 | 3 | 1 | 2 | 21 | 27 |
| shadcn/ui | 2 | 2 | 1 | 2 | 1 | 3 | 3 | 2 | 1 | 2 | 19 | 25 |
| USWDS (benchmark) | 3 | 2 | 3 | 1 | 1 | 1 | 3 | 2 | 1 | 2 | 19 | 25 |
| Fluent UI React v9 | 2 | 2 | 2 | 2 | 1 | 2 | 3 | 3 | 1 | 1 | 19 | 24 |
| HeroUI v3 | 2 | 2 | 1 | 2 | 1 | 2 | 2 | 1 | 1 | 2 | 16 | 22 |

Reading the table. No candidate scores above 1 on email: the email story is ours to build in `packages/email` from whatever token source we choose, so criterion 5 reduces to "are the tokens available as plain data" (Radix Colors JS objects, Chakra/Panda token JSON, our own build step). The headless substrates win because criteria 4 and 10 dominate: the MCP App card lives in a host iframe that hands us a small set of CSS variables and a font (§6), and nothing with a global stylesheet or a baked look survives that cleanly. The styled kits that score well (Radix Themes, Mantine, Chakra) do so because their token layer is real and their look is removable; the corporate systems (Carbon, Primer) lose only on re-skin, and remain the best references for the dashboard and for token structure.

## 5. Shortlist

1. **React Aria Components as the behaviour layer, with A2H's own token system on top (recommended).** Take: components (behaviour, keyboard, focus, i18n, Table, SegmentedControl via ToggleButtonGroup/RadioGroup, NumberField, Toast, Dialog). Build: tokens as proposed in `docs/design/foundations-brainstorm.md` §4 (OKLCH primitives on a lightness ladder with USWDS-style grade arithmetic and Radix-style step semantics), semantic layer, component CSS in CSS modules or Tailwind v4 via the official plugin. Why: the only candidate with WCAG 2.2 criteria cited by name and a published screen-reader matrix (https://react-aria.adobe.com/quality), zero CSS so the card is a clean guest in a host, Apache-2.0, Adobe-maintained with releases this month. Risk: about 35–40 components to style before anything ships; everything is a client component (fine for forms, costs a little on the request page); no Figma, so the Figma library is ours to make (or borrow Untitled UI's, which maps to RAC).
2. **Radix Themes with Radix Colors, custom scales.** Take: both, with `grayColor` set to a warm custom scale and `accentColor`/human generated as two 12-step scales honouring the Lc 60/Lc 90 rule (https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale); fonts via the six font variables. Why: shortest path to a complete, coherent kit (approx. 50 components, SegmentedControl, Table, DataList) with a real three-layer token model and a documented contrast guarantee. Risk: Themes last released 2026-01-31 and Colors 2023-10-02; CSS does not tree-shake and `.radix-themes` scoping still puts tokens and utilities on the host page; the system-font/radius grammar leaks the "Linear look"; no official Figma.
3. **Mantine.** Take: components (the widest PWA + dashboard coverage, SegmentedControl, Stepper, Table, Notifications) and its CSS-variable theme as the semantic layer, overriding colour shades from our OKLCH ladder. Why: easiest re-skin of the styled kits, MIT, 9.7.3 on 2026-10-17, App Router template. Risk: a required global stylesheet (not a guest-friendly card), no accessibility statement to cite in an audit, no official Figma, and a default look that reads "admin template" unless the theme is pushed hard.
4. **Chakra v3 family, specifically Ark UI + Panda CSS (Park UI as a starting style).** Take: Ark behaviour and Panda's token/semantic-token/condition model and zero-runtime CSS; discard Park UI's look. Why: the token model is the most faithful implementation of "primitive → semantic → component with light/dark conditions" in the field, and the build-time CSS fits the 3G budget. Risk: Panda is a build step alongside or instead of Tailwind; Ark's accessibility evidence is thinner than React Aria's; Park UI maintenance **unverified**.
5. **Not a base, but take from them:** Primer primitives' functional roles and colour-blind/high-contrast themes; Carbon's DataTable patterns and type tokens; USWDS's grade arithmetic as the CI contrast rule.

The three systems whose live demos the owner should open first: Radix Themes playground (https://www.radix-ui.com/themes/playground, switch gray to Sand and accent to Teal, then dark), React Aria Components gallery and starter kits (https://react-aria.adobe.com/), Mantine (https://mantine.dev/, toggle the colour scheme in the header). Open Carbon's Storybook (https://react.carbondesignsystem.com/) fourth, for the DataTable only.

## 6. Embedded-card references

What the "small card in someone else's UI" case actually demands, from the two best-known embeds and from the MCP Apps specification. All fetched 2026-10-21.

- **Stripe Elements Appearance API.** Stripe mounts an iframe per Element (https://docs.stripe.com/js/element/mount.md); the host cannot style it with CSS, only through a typed contract: three themes (`stripe`, `night`, `flat`), variables (`fontFamily`, `fontSizeBase` "at least 16px for input fields on mobile", `spacingUnit`, `borderRadius`, `colorPrimary`, `colorBackground`, `colorText`, `colorDanger`, plus `accessibleColorOnColorPrimary`, focus and input variables, a type scale `fontSize3Xs…2Xl` "scaled from var(--fontSizeBase) using rem"), and rules on an allow-list of selectors (`.Tab`, `.Input`, `.Label`, `.Block`…) with state modifiers (`--selected`, `--invalid`, `--focused`); `disableAnimations: true` (https://docs.stripe.com/elements/appearance-api.md). Fonts arrive via `fonts: [{cssSrc}]` or `@font-face` sources (https://docs.stripe.com/js/elements_object/create.md).
- **Stripe Connect embedded components.** "The font family and background color of Connect embedded components are inherited from the parent HTML container. You must explicitly set all other options."; width follows the parent, height is content-driven; "These options are the only way to change styles" (https://docs.stripe.com/connect/get-started-connect-embedded-components.md, https://docs.stripe.com/connect/embedded-appearance-options.md). Variables add badge (neutral/success/warning/danger) and heading/label/body type steps. Figma toolkit: https://www.figma.com/community/file/1438614134095442934.
- **MCP Apps (SEP-1865, Final; spec 2026-01-26).** Apps render as `ui://` resources in a sandboxed iframe; the host returns a `HostContext` from `ui/initialize` and updates it on theme or size change: `theme: "light" | "dark"`, `styles.variables` (standardised names for background, text, border and ring colours, font family/weight/size/line-height, radius, border width, shadows, with values such as `light-dark(#ffffff, #171717)`; "Spacing is intentionally excluded"), `styles.css.fonts` (`@font-face` or `@import`), `displayMode` inline/fullscreen/pip, `containerDimensions`, `locale`, `timeZone`, `platform`, `deviceCapabilities { touch, hover }`, `safeAreaInsets`; views must define fallbacks; SDK helpers `applyHostStyleVariables`, `applyHostFonts`, React `useHostStyles` (https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp, https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/main/specification/2026-01-26/apps.mdx).
- **Linear.** Themes are generated, not hand-authored: three inputs ("base color, accent color, and contrast") expand in LCH to "more than a hundred color variables", scoped per surface by nested ThemeProviders (https://linear.app/now/how-we-redesigned-the-linear-ui, https://linear.app/now/styling-linear-for-the-future-stylex). The 2026 refresh moved the neutral "toward a warmer gray that still feels crisp, but less saturated", tuned with an internal hue/chroma/lightness tool and exported as JSON into Figma (https://linear.app/now/behind-the-latest-design-refresh). Inter Display for headings, Inter for body (redesign post). Radius values: **unverified**.
- **Consequence for A2H.** The card's token surface must be a *subset* that maps one-to-one onto what hosts give (MCP `styles.variables`) and what Stripe proved hosts will accept: colour roles for background/text/border/primary/danger, one font family and base size, one radius, no spacing. Our origin hues (ochre for the human, teal or ink for the platform) are the only tokens the card keeps as its own; everything else inherits. This is the "guest subset" of `foundations-brainstorm.md` §4.10, now with two external precedents. Whichever shortlist option is chosen must allow a build that ships zero global CSS into the iframe; React Aria Components and Base UI do by construction, Radix Themes and Mantine need a stripped card bundle.

## 7. Open questions for the product owner

1. **Own the design layer (option 1 or 4) or inherit one (option 2 or 3)?** Owning costs roughly a milestone of design-system work before M1 UI ships; inheriting costs a permanent "looks like Radix/Mantine" tax and a stripped card build.
2. **Is a shadcn-style copy-in distribution acceptable** (we own and patch component source) or must components stay upstream dependencies? This decides between option 1 via shadcn's `aria` base and option 1 built by hand.
3. **Figma.** Only Carbon, Primer, Fluent, USWDS and HeroUI have an official kit; React Aria, Radix Themes and Mantine do not. Is a Figma library a requirement for M1, or is Storybook the design source of truth until later?
4. **Fonts.** Every survivor defaults to the system stack; none ships a typeface except Carbon (Plex) and USWDS. The font decision from the brainstorm (one variable sans, serif reserved for human words or none) stands independent of this choice.
5. **Which facts to confirm before an ADR:** Carbon, Primer and Fluent Figma kits and RSC statements; Mantine's keyboard coverage on SegmentedControl and Stepper; Park UI's maintenance; Radix Themes' release plan after 3.3.0 (nine months without a release at the time of writing).
