# Design: m2-org-sign-in

## Context

Sign-in today is a magic link to an address on an allow-list (ADR 0004). Better Auth 1.7.14 in `apps/web` is also the OAuth 2.1 authorization server for MCP clients. PRD v0.3 makes A2H an install an organisation runs for its own people, so people come in through the organisation's identity provider and administrators manage access. The technical facts behind the decisions below, with source references, are in `notes/technical-findings.md`. Nothing there was run against a provider; "not verified" items are listed at its end and repeated under Risks.

## Goals / Non-Goals

Goals: every scenario of the two spec deltas; no weakening of the existing gates on development stages; a production configuration in which magic-link code cannot be reached.

Non-goals: switching a person off as a participant, profiles, groups, SAML, SCIM, several providers, the install package (later changes).

## Decisions

### D1 Mechanism: Better Auth's `genericOAuth` plugin, one provider
One entry with the fixed provider id `idp`, configured by discovery URL, client id and client secret, with ID-token verification required. The plugin checks state (single use), PKCE S256, nonce, signature, issuer, audience and expiry. The address the organisation registers is `https://<web host>/api/auth/callback/idp`. Better Auth's `sso` and `admin` plugins are not used: the first is built for many providers per tenant, the second brings impersonation and password endpoints and has no action record or last-administrator rule.

### D2 Sign-in starts from a server action only
The HTTP path `/sign-in/social` also accepts a raw ID token. It is disabled, as `/sign-in/magic-link` is today; the sign-in page calls a server action that starts the redirect. A test posts to the path and expects a refusal.

### D3 Who is let in: `validateUserInfo`
The refusals of the spec are decided before any user, account or session is written: no email address or no verified assertion; an email address another account already has; access removed (D7). Each returns its own error code so the right page is shown. The claim that carries the verified assertion is a setting (`IDP_EMAIL_VERIFIED_CLAIM`, default `email_verified`; `xms_edov` for Microsoft Entra ID).

### D4 Matching: by subject; never by email address on a production install
The provider's subject is stored in the existing `account` table. Implicit linking by email address is disabled on production (`accountLinking.disableImplicitLinking`), because a reassigned address would otherwise open its previous holder's account. On development stages linking stays as the library does it, so one person can use both methods.

### D5 Nothing from the provider is kept except identity
A database hook removes the provider's access, refresh and ID tokens before the `account` row is written. A test reads the row after sign-in.

### D6 Sessions and the renewal window
- Session: 12 hours, no sliding renewal (`expiresIn` 43200, session refresh disabled) for people who signed in through the provider. Magic-link sessions on development stages keep today's lifetime.
- `user.last_idp_sign_in_at` is written at each successful provider callback. The hook to use is not confirmed (`newSession` in an `after` hook on the callback route, or the fallback in the findings); the first build task proves one with a test.
- Refresh: the existing token-endpoint hook (`customTokenResponseFields`) refuses with `invalid_grant` and a description naming the cause when the user has a provider account and `last_idp_sign_in_at` is older than 7 days. The refresh-token family is not revoked, so a token the client kept works again after a new sign-in. The window is a constant in `packages/protocol`.
- Users without a provider account (magic link, development stages) are outside this rule. Existing users get a null value at migration and stay outside it.

### D7 Access state and administrators
- `user` gains `access_removed_at` (null = has access), `is_administrator`, `last_idp_sign_in_at`. New append-only table `administrator_actions` (id, actor, subject, action `remove_access` | `restore_access` | `grant_administrator` | `withdraw_administrator`, at), protected by the repo's existing no-update, no-delete trigger pattern.
- Administrators named in the configuration (`ADMINISTRATOR_EMAILS`) are computed at each check, not stored. A person is an administrator when they have access and are either named or flagged.
- Removing access sets the column, deletes the person's sessions and revokes their refresh-token families in one transaction with the action row. The four places that ask the allow-list today (user creation, session creation, the request gate, the token endpoint) and consent ask one predicate: access not removed, and, for people without a provider account, on the allow-list.
- Last-administrator and own-access rules are enforced inside the same transaction, under a lock on the administrators' rows.
- The people list query selects name, email address, access and administrator only. A test asserts that `last_idp_sign_in_at` is not selected.

### D8 Stages and configuration
- `SIGN_IN_METHODS` per stage: production `idp`; dev `idp,magic_link` once the owner has registered the application, `magic_link` until then; previews `magic_link` only (redirect addresses are per host, and a preview cannot reach a test provider on the CI runner).
- With `magic_link` absent the magic-link plugin is not registered: its paths return 404 and no code path can create a link. Production stops receiving the allow-list parameter and the permission to read it.
- New settings: `IDP_DISCOVERY_URL`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET` (stage secret), `IDP_EMAIL_VERIFIED_CLAIM`, `ADMINISTRATOR_EMAILS`. Read through `apps/web/src/config.ts`; no AWS SDK in the sign-in code.
- The Better Auth instance built per transaction at consent is built without the provider plugin, so discovery is not fetched again.
- Discovery happens once per server instance. If it fails, the sign-in page shows "unavailable, try again" and the next request retries.

### D9 Verification method
`organisation_idp` is added to the allowed methods (constant and check constraint, one migration). `ensurePrincipal` receives the method from the session: the provider account's presence on the session's user at consent.

### D10 Tests
- Unit and contract tests run against a small fake issuer started in the test process (signed tokens, wrong issuer, wrong audience, reused state, missing and unverified email).
- One end-to-end suite runs against Keycloak (image pinned, realm imported with two test users) as a container next to Postgres in CI, on a locally started web app. Not on previews.
- Existing magic-link suites keep running unchanged on previews and dev.
- A production-configuration test starts the app with `SIGN_IN_METHODS=idp` and proves every magic-link route and server action refuses.

### D11 Ownership
`apps/web` and the sign-in settings in `infra/`: Web dev. `packages/db` (migration, queries) and the protocol constant: Protocol dev. Tests in `tests/`, the Keycloak job in CI: QA. Screens and components: Design. Runbooks and ADR 0008: PM.

## Risks / Trade-offs

- **Not run yet.** No flow has been executed against Keycloak, Google, Okta or Entra. The first build task is a spike that signs in against Keycloak and proves D1, D3, D5 and the hook of D6 before anything else is built on them.
- **How MCP clients react to `invalid_grant`** (keep the token and retry, or start over) is not tested. Either way no consent screen is shown; QA records what Claude Code and MCP Inspector do.
- **Entra's `xms_edov`** and Okta's refusal of unassigned users are taken from vendor pages, not tried. Reported as not validated unless test tenants exist.
- **Administrators named by email address**: if the provider reassigns the address, its new holder is an administrator. Stated in the runbook.
- **Entra's subject is per application**: registering the application anew locks everyone out with linking off. Stated in the runbook.
- **Two methods on dev** double the gate logic. D7's single predicate and D10's production-configuration test are the guard.

## Migration Plan

One migration: three `user` columns (null/false defaults), the actions table with its trigger, the widened check constraint. No backfill. Dev keeps `magic_link` until the owner has stored the provider settings; then `idp,magic_link`. Rollback: remove `idp` from `SIGN_IN_METHODS`.

## Open Questions

None for the owner. For the build: the hook for `last_idp_sign_in_at` (D6).

## Screens

Written by Design in `screens.md` and `screens/` (in progress).
