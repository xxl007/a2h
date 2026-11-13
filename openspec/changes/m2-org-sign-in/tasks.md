# Tasks: m2-org-sign-in

Gate 1 passed 2026-11-11 (Google Workspace on dev for Gate 2; 7-day renewal window; removing access keeps the record). Owners: PD = Protocol dev, WD = Web dev, QA, Design, PM. Every task is test first; each scenario of the two deltas maps to a named test (`tests/README.md`). Decisions D1–D11 are in `design.md`; source references in `notes/technical-findings.md`.

## 1. Decisions and ADR (PM)

- [x] 1.1 Record the Gate 1 answers and the clarifications from the findings in proposal.md and the deltas — done 2026-11-11
- [x] 1.2 ADR 0008 "Sign-in through the organisation's identity provider" (amends ADR 0004 decision 3) — done 2026-11-11, status proposed until Gate 2

## 2. Spike: prove the mechanism (WD)

- [x] 2.1 On a throwaway branch, sign in on a locally started web app against Keycloak (pinned image, imported realm, one user) with `genericOAuth`, provider id `idp`. Prove by test or recorded output: callback path `/api/auth/callback/idp`; a refusal from `validateUserInfo` writes no user, account or session (D3); provider tokens are absent from the `account` row (D5); which hook can write `last_idp_sign_in_at` (D6); `/sign-in/social` over HTTP is refused (D2); session ends at 12 h without sliding (clock moved). Acceptance: a short report in `notes/spike.md` stating what was run and its output, and any decision of design.md that does not hold. Nothing from the spike is merged except the report and reusable test helpers. — done 2026-11-13: 9 tests against Keycloak 26.8.2 and Postgres 17, all eight points hold except a per-method session lifetime (D6 changed to 12 h for every session); report in `notes/spike.md`; reusable Keycloak helper on branch `spike/m2-org-sign-in` under `apps/web/test/idp-spike/keycloak/`, to be taken over by QA in 7.1

## 3. Protocol and data (PD)

- [ ] 3.1 `packages/protocol`: constants for the session lifetime (12 h) and the renewal window (7 days); tests pin them
- [ ] 3.2 `packages/db`: one migration (`user.access_removed_at`, `user.is_administrator`, `user.last_idp_sign_in_at`; `administrator_actions` with the no-update, no-delete trigger; `organisation_idp` in the verification-method constraint), schema, drift test
- [ ] 3.3 Queries, each with Data API stand-in tests: the access predicate (D7); list people (selected columns asserted: no `last_idp_sign_in_at`); remove access (sessions deleted, refresh families revoked, action row, one transaction); restore access; grant and withdraw administrator; the last-administrator and own-access refusals under a lock, including two concurrent removals; `ensurePrincipal` taking the method. Tests named for "Access removed", "Access restored", "Access of an administrator removed", "Administrator removes their own access", "Role granted", "Last administrator", "Action recorded", "Refused action leaves no change", "Consent creates a principal verified by the organisation", "Second consent leaves verification as stored"

## 4. Design (Design)

- [x] 4.1 `screens.md` and `screens/`: sign-in (production, development, unavailable, session ended), refusal pages, people and access, record, not-administrator; copy; states; accessibility — done 2026-11-11 (40 specs; axe, targets, overflow: 240 runs, no finding; keyboard pass not run on static specs)
- [ ] 4.2 `packages/ui`: `PersonRow`, `PeopleScreen`, `SearchField`, `ChoiceGroup`, `ActionRecord`/`RecordScreen`, `AdminNav`, `AccessRefusedScreen`, `NotAdministratorScreen`, `AuthShell` header links, `SignInScreen` methods and notices; stories for every state in `screens/`; axe and keyboard pass at 320/390/1280, light and dark, reduced motion

## 5. Sign-in (WD), after 2 and 3

- [ ] 5.1 Configuration: `SIGN_IN_METHODS`, the provider settings, `ADMINISTRATOR_EMAILS`, the two optional copy settings (D8); a production configuration without them refuses to start; `infra/` passes them per stage (dev `magic_link` until the owner's settings exist; previews `magic_link`), production no longer receives the allow-list parameter or its permission; config and infra tests
- [ ] 5.2 Provider sign-in: plugin registration, server action, `validateUserInfo` refusals with their codes, token stripping, no linking by email on production, the consent-time instance without the plugin, the unavailable state. Tests against the fake issuer for "First sign-in creates the account", "Returning person is recognised by the provider's identifier", "Email address not verified", "Email address already used by another account", "Never matched by email address alone", "Answer not meant for this install" (issuer, client, state, nonce, reuse), "Person cancels or the provider refuses", "Provider cannot be reached"
- [ ] 5.3 Session and renewal: 12 h without sliding for provider sign-ins; `last_idp_sign_in_at`; the token-endpoint refusal with `invalid_grant`, family kept. Tests for "Session reaches twelve hours", "Agent renews within the window", "Agent renews after the window", "Principal signs in again" (both halves)
- [ ] 5.4 Gates: the single predicate at user creation, session creation, the request gate, the token endpoint and consent; method-aware on development stages. Tests for "Each method keeps its own rules", and the existing "Address removed from the allow-list" still green. The predicate is checked on every use of a session, not only at its creation, so a sign-in racing a removal cannot leave a live session (cold review of #136); a test races them
- [ ] 5.5 Production configuration: with `SIGN_IN_METHODS=idp` every magic-link route and server action refuses and the page offers the organisation's sign-in only. The app passes the methods to `SignInScreen` explicitly (its default is magic link, cold review of #137); a test renders the production sign-in page and finds no email field. Tests for "Production install", "Both methods on a development stage", "Preview sign-in" unchanged
- [ ] 5.6 Pages: sign-in variants, refusal pages, session-ended notice, signed-out sentence, per `screens.md`; Playwright at 390 and 1280
- [ ] 5.7 Logging: no email address, name or provider token in any new log line (test over every new line); the refusal reference is the request id with a cause code

## 6. People and access (WD), after 3 and 4.2

- [ ] 6.1 Server actions behind the administrator check: list, remove, restore, grant, withdraw; refusals mapped to the screens' messages. Tests for "Configured administrator signs in", "Anyone else opens the administrators' page" (page and every action, signed in and not), "New person appears"
- [ ] 6.2 Pages: people and access (search and paging in the browser, up to 1,000), confirmations, the record, the header link for administrators only; Playwright for remove then restore, grant then withdraw, the three refusals, keyboard-only, 390 px

## 7. Verification (QA)

- [ ] 7.1 Test helpers: the fake issuer (signed ID tokens, discovery document, faults on demand) usable by `apps/web` tests and `tests/`; the Keycloak container job in CI next to Postgres with the imported realm
- [ ] 7.2 End to end against Keycloak on a locally started stack: sign in, consent, `request_human` to a simulated participant, the principal shown as verified by the organisation; removal signs the second account out and refuses its agent; `tests/README.md` map for every scenario of both deltas
- [ ] 7.3 Adversarial, each red against a weakened check, then green: forged ID token (wrong key, wrong issuer, wrong audience, expired); replayed callback; raw ID token posted to `/sign-in/social`; sign-in as an existing account's email address with a new subject; magic-link request on a production configuration by every route; a removed person's refresh token and existing access token; a non-administrator calling each administrator action directly; two administrators removing each other at once; editing or deleting an action row by SQL
- [ ] 7.4 Record what Claude Code and MCP Inspector do on `invalid_grant` at refresh (keep and retry, or start over); report, no pass or fail

## 8. Docs, review and gate (PM)

- [ ] 8.1 Runbooks: registering A2H in Google Workspace, Okta and Microsoft Entra ID (the verified-email claim, restricting to the organisation, the subject per application in Entra, administrators named by email address); what was validated and what was not
- [ ] 8.2 Owner steps for dev: the redirect address, the command that stores the client secret, then `idp,magic_link` on dev
- [ ] 8.3 Cold review of every PR (Reviewer); sync sweep; Gate 2 message with the five validation steps of the proposal
- [ ] 8.4 Archive: deltas into `openspec/specs/`, ADR 0008 accepted, PRD §13 M2 progress, the groups check (how each provider exposes groups) recorded for M3
