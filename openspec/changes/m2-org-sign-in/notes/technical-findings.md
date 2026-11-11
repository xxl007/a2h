# Findings: m2-org-sign-in (technical input for design.md)

Web-dev, 2026-11-11. Read-only research; nothing in the repo was changed.

## How each claim was checked

- **[src]** read in the installed packages at 1.7.14. Paths below are relative to these roots:
  - `BA` = `/home/galem/a2h/apps/web/node_modules/better-auth/dist` (pnpm link to `better-auth@1.7.14`)
  - `CORE` = `/home/galem/a2h/node_modules/.pnpm/@better-auth+core@1.7.14_*/node_modules/@better-auth/core/dist`
  - `OP` = `/home/galem/a2h/node_modules/.pnpm/@better-auth+oauth-provider@1.7.14_*/node_modules/@better-auth/oauth-provider/dist/authorize-B1Bc3IL6.mjs`
  This is the strongest evidence: it is the code we run. Line numbers are those of the built files.
- **[doc]** read on the vendor's documentation page today (URLs at the end).
- **[repo]** read in the worktree `/var/tmp/a2h-m2-org-sign-in`.
- **[unverified]** not confirmed; listed again in the last section.

**Context7 was not usable in this session** (the server answered "Invalid API key"). Every library claim therefore rests on the installed source and on the vendor's own pages, not on Context7. **Nothing was executed**: no sign-in flow was run against any provider, no test was written or run.

---

## 1. Better Auth 1.7.14: which mechanism

### Recommendation: the `genericOAuth` plugin (in `better-auth/plugins`, already installed), one entry, `discoveryUrl` + `requireIdTokenVerification: true`

| Option | Verdict | Why |
|---|---|---|
| `genericOAuth` | **Best fit** | Static configuration of one provider from env; no new package, no new table; OIDC discovery, ID-token verification, nonce, PKCE built in [src `BA/plugins/generic-oauth/index.mjs`]. |
| `@better-auth/sso` | Not for this change | Separate package, not installed. Adds an `ssoProvider` table and runtime registration by signed-in users (`providersLimit`), provider selection by email domain, SAML, organisation provisioning [doc]. A static `defaultSSO` exists, but everything else is surface to switch off. It is the natural base for the paid edition (SAML, several providers). |
| Built-in `socialProviders.google` / `microsoft` | No | One code path per vendor; the spec wants one standard OIDC configuration. |
| Helpers `okta()`, `keycloak()`, `microsoftEntraId()` inside genericOAuth | Not needed | `okta()` and `keycloak()` only build the discovery URL and fix the provider id [src `BA/plugins/generic-oauth/providers/{okta,keycloak}.mjs`]. `microsoftEntraId()` changes the subject to `oid` and sets `emailVerified` false when the claim is absent [src `providers/microsoft-entra-id.mjs`]; see Entra in section 4. |

### Config shape (names from `BA/plugins/generic-oauth/types.d.mts`) [src]

```ts
genericOAuth({ config: [{
  providerId: "idp",                       // fixed by us; it is part of the redirect URI
  discoveryUrl: `${issuer}/.well-known/openid-configuration`,
  requireIdTokenVerification: true,        // provider is not registered unless discovery gives issuer + jwks_uri
  clientId, clientSecret,
  scopes: ["openid", "email", "profile"],
  pkce: true,                              // default
  overrideUserInfo: true,                  // name and email refreshed at each sign-in
  // disableIdTokenNonceBinding: false (default), allowIdpInitiated: false (default)
}] })
```

Sign-in starts through the core endpoint `POST /sign-in/social` with `{ provider: "idp", callbackURL, errorCallbackURL }`; it returns the provider's authorize URL. There is no plugin-specific endpoint [src `index.mjs` comment "Providers are used through the standard signIn.social and callback/:id core endpoints"; doc].

### Callback path: what the organisation registers

`https://<web host>/api/auth/callback/idp`, i.e. `${baseURL}${basePath}/callback/:providerId` [src `BA/oauth2/utils.mjs` `getOAuthCallbackPath`; doc generic-oauth]. The provider id is part of the install contract: choose it once (`idp` suggested) and never rename it.

### What is validated [src]

| Check | Done? | Where |
|---|---|---|
| `state` | Yes. Random 32 chars, stored in the `verification` table (10 min) plus a signed cookie; both must match (line 136); the row is deleted on use (line 142), so a second callback with the same state fails (`state_mismatch`); expiry checked (line 144). | `BA/state.mjs` `generateGenericState` / `parseGenericState` |
| PKCE (S256) | Yes by default (`c.pkce ?? true`); verifier kept in the state row. | `BA/plugins/generic-oauth/index.mjs` `createAuthorizationURL`, `validateAuthorizationCode` |
| `nonce` | Yes when discovery publishes `jwks_uri` and `issuer` (`requiresIdTokenNonce`, line 157): sent on the authorize URL, kept in state, compared to the ID token's `nonce`; a missing expected nonce is `nonce_binding_missing`. | `BA/oauth2/callback.mjs:24`, `CORE/oauth2/verify-id-token.mjs:57` |
| ID token signature | Yes, against the discovered JWKS, algorithms limited to the discovery document's list. | `index.mjs:231` -> `CORE/oauth2/verify-id-token.mjs:56` (`jwtVerify`) |
| `iss` | Yes, equals the discovery `issuer` (line 28). Also the RFC 9207 `iss` callback parameter when the provider sends one (`issuer_mismatch`). | `verify-id-token.mjs:28`, `BA/oauth2/callback.mjs:20` |
| `aud` | Yes, equals `clientId` (`audience: c.clientId`). | `verify-id-token.mjs:29` |
| `exp`, `iat`, required claims `iss sub aud exp iat` | Yes, 30 s tolerance. | `verify-id-token.mjs` `ID_TOKEN_REQUIRED_CLAIMS` |
| Code replay | By the provider (single-use code) and by the consumed state. | - |

Two caveats found in the source:

1. **Without `requireIdTokenVerification`, a failed discovery downgrades silently**: `fetchUserInfo` then only *decodes* the ID token (`index.mjs:50`, `decodeJwt`). With the flag (line 132) the provider is skipped and discovery is retried on the next request (10 s timeout, `retryDiscovery`). The flag is mandatory for us.
2. **`POST /sign-in/social` also accepts a client-submitted ID token** (`body.idToken`, `BA/api/routes/sign-in.mjs:154-212`), verified against the same JWKS but with a nonce only if the caller supplies one. That is a second way in that the spec does not want ("an answer already used"). genericOAuth does not expose `disableIdTokenSignIn` (the provider's `options` object at `index.mjs:272` carries only `disableSignUp`, `overrideUserInfoOnSignIn`, `requireEmailVerification`). Close it the way magic link is closed today: put `/sign-in/social` in `disabledPaths` and start sign-in from a server action through `auth.api.signInSocial` (the action must forward the `Set-Cookie` headers of the state cookie before redirecting). That `disabledPaths` only blocks HTTP (`BA/api/index.mjs:167-169`) and leaves `auth.api` working is what the current magic-link code relies on [repo `apps/web/src/auth/auth.ts:134`].

### Mapping of claims [src `index.mjs` `fetchUserInfo` lines 48-73, `getUserInfo` 228-250; `BA/api/routes/callback.mjs`; `BA/oauth2/link-account.mjs`]

- Profile = the verified ID token's claims when it carries `sub` and `email`; otherwise the userinfo endpoint.
- `sub` -> `account.accountId` with `account.providerId = "idp"` (`accountSubject`, `index.mjs:148`; `BA/oauth2/account-key.mjs`). OIDC discovery providers always use `sub`; "Better Auth never switches between fields at runtime" [types.d.mts].
- `email` -> `user.email` (lower-cased); `email_verified` -> `user.emailVerified`; `name` -> `user.name` (empty string if absent); `picture` -> `user.image`.
- **The provider's subject is stored in the existing `account` table** [repo `packages/db/src/auth-schema.ts`, `account.account_id` / `provider_id`]: no new column is needed. The proposal's "accounts gain the provider's subject identifier" is already covered.

### How an existing user is matched: account-linking risk [src `BA/oauth2/link-account.mjs` `handleOAuthUserInfo`]

1. First by `(providerId, accountId)` (`findAccountOwnerByKey`, line 80): the subject. This satisfies "Returning person is recognised by the provider's identifier"; with `overrideUserInfo: true` the stored email and name are updated.
2. **If no account matches, by email** (`findUserByEmail`, line 120). An existing user with the same email gets the new subject *linked implicitly* unless the condition at line 141 refuses it: provider email unverified, local email unverified, `accountLinking.enabled === false` or `accountLinking.disableImplicitLinking === true`. Consequences:
   - Production: a leaver's address reassigned to a new employee (new `sub`, same email) would land in the leaver's A2H account, with the leaver's consents and principal. Microsoft's own page warns about exactly this reuse [doc, ID token claims reference, "Use claims to reliably identify a user"].
   - Dev stage: a magic-link user and the same address at the provider become one user (probably wanted there).
   - Fix: `account: { accountLinking: { disableImplicitLinking: true } }` (or `enabled: false`): the callback then fails with `account_not_linked` and no session [src line 141-146; doc users-accounts]. Design must decide what the person sees and whether dev stages keep linking. With linking off, the reassigned-address case becomes "contact an administrator", which needs an administrator action that does not exist in the spec (section 6).

### Refusing a missing or unverified email

- **Missing email**: the callback stops with `email_not_found` before any row is written [src `BA/api/routes/callback.mjs:127-130`].
- **Unverified email**: do **not** use the plugin's `requireEmailVerification`: it creates the user and the account and only withholds the session [src `types.d.mts` comment; `link-account.mjs:319-326`], which breaks "no account or session is created".
- **Use `user.validateUserInfo`** [src `CORE/types/init-options.d.mts:877`, `BA/utils/validate-user-info.mjs`; doc users-accounts and generic-oauth]. It runs before a user is created (`BA/db/internal-adapter.mjs:164`, inside `createUser`), before a link (`link-account.mjs:150`), and on every returning OAuth sign-in (`link-account.mjs:196`), with the raw verified claims in `source.oauth.profile`. Returning `{ error: "email_not_verified" }` raises a 403 `APIError` that the callback turns into a redirect to `errorCallbackURL?error=email_not_verified` (`callback.mjs` catch around `handleOAuthUserInfo`). It fails closed if it throws. Accept `email_verified === true` and the string `"true"` (Google's page shows a string in its example payload [doc]).
- Logging: the callback's own error logs carry codes, not the address [src `BA/oauth2/errors.mjs`]. The claims object must never be passed to our logger.

### Other things the plugin does that we must handle

- **Provider tokens are written to `account`** (`idToken`, `accessToken`, optionally `refreshToken`; `link-account.mjs:167, 214, 271`). `setTokenUtil` encrypts access/refresh tokens only when `account.encryptOAuthTokens` is set, and never the ID token [src `BA/oauth2/utils.mjs`]. The ID token contains the name and email. Today's schema comment says "`account` holds no provider token: no social sign-in" [repo `packages/db/src/auth-schema.ts` header]. We need none of them (no `offline_access`, no provider logout by `id_token_hint`). Strip them in `databaseHooks.account.create.before` / `update.before`.
- **Errors**: pass `errorCallbackURL` (the sign-in page) with the sign-in call; set `onAPIError.errorURL` too, because failures before the state is parsed (`state_not_found`, `state_mismatch`) go to the default `${baseURL}/error` [src `callback.mjs`, `BA/oauth2/state.mjs` `parseState`]. A cancel at the provider arrives as `?error=access_denied` at the same URL (`callback.mjs:86`): the "neutral message" scenario.
- **Discovery is fetched in the plugin's `init`**, i.e. once per Better Auth instance [src `index.mjs` `init`]. `decideConsent` builds a new instance per transaction (`authOn(tx)`) [repo `apps/web/src/auth/consent.ts`, `apps/web/src/server/runtime.ts:55-57`], which would fetch the provider's discovery document over the internet inside a database transaction at every consent. The per-transaction instance must be built without the genericOAuth plugin.

---

## 2. principal-identity scenarios

| Scenario | How | Evidence |
|---|---|---|
| First sign-in creates the account | Default path: user + account created in one transaction (`runWithTransaction`), then the session (`link-account.mjs:328`). | [src] |
| Returning person, email changed | Match by subject; `overrideUserInfo: true` updates email/name. Edge: the new address already belongs to another user -> unique violation, not handled gracefully (section 6). | [src] |
| Email not verified / missing | `validateUserInfo` / `email_not_found`, see section 1. | [src] |
| Answer not meant for this install | Issuer, audience, state, nonce, single-use state: all enforced, given `requireIdTokenVerification` and `/sign-in/social` closed over HTTP. | [src] |
| Cancel / provider error | Redirect to `errorCallbackURL?error=…`, no session. | [src] |
| Principal verified by `organisation_idp` | `ensurePrincipal` hardcodes `owner_allowlist` [repo `packages/db/src/queries/principals.ts:91`]; it needs a method parameter; `PRINCIPAL_VERIFICATION_METHODS` [repo `packages/db/src/schema.ts:569`] and the check constraint `principals_verification_method_known` (line 590) need the new value (migration). On a dev stage the method must follow *how this person signed in* (section 6). | [repo] |

### Session capped at 12 h, no sliding

`session: { expiresIn: 43200, disableSessionRefresh: true }`. With refresh disabled the expiry set at creation is never extended [src `BA/api/routes/session.mjs:178-183`; doc session-management]. `cookieCache` is off unless enabled [src `BA/cookies/index.mjs:77`], so every read hits the database and a deleted session ends at once. Applies to magic-link sessions too (harmless).

OAuth refresh tokens do **not** depend on the session staying alive: `oauth_refresh_token.session_id` is `ON DELETE SET NULL` [repo `packages/db/src/auth-schema.ts:205-207`] and the refresh grant only loads the user [src `OP` lines 2353-2372]. So a 12 h session cap does not cut agents off. The authorization-code grant does require a live session (`OP` lines 2204-2213), which is always true at that moment.

### Recording "last sign-in at the provider"

- A column on `user`, declared as a Better Auth `user.additionalFields` entry (`input: false`) so the generated schema carries it and Better Auth returns it with the user row: `last_idp_sign_in_at timestamptz null`.
- Written when the callback creates a session: an `after` hook on `/callback/:id` reading `ctx.context.newSession` (set at session creation [src `BA/context/create-context.mjs:192`]). Not `account.updatedAt` (only touched when tokens change) and not the refresh token's `authTime` (the time of the sign-in that created that token, not the latest one).
- **[unverified]** that `newSession` is populated when an `after` hook runs on the callback route, which ends by throwing a redirect. Fallback with the same effect: `databaseHooks.session.create.after` checking that the endpoint context's path is the callback. To be settled by the first failing test.

### Refusing the refresh after 7 days

- Hook point: the existing `customTokenResponseFields` (today `refuseRemovedPrincipal`, [repo `apps/web/src/auth/auth.ts:109-120, 191`]). It runs for `authorization_code` and `refresh_token` and receives the full user row (`findUserById`, `OP` line 2353), so `last_idp_sign_in_at` and the access state arrive without an extra query.
- **Error: `invalid_grant`** (RFC 6749 §5.2: the grant is "invalid, expired, revoked"), HTTP 400, with an `error_description` such as "the principal must sign in again". `login_required` is an authorization-endpoint error (OIDC) and is not defined for the token endpoint. Better Auth itself answers `invalid_grant` for a bad refresh token [src `OP` lines 2312-2350].

#### Clarification: does the same refresh token work again, or must the client start a new authorization?

Both statements in my earlier summary are true, but they are about two different parties. Precisely:

- **Server side: the same refresh token stays valid.** `customTokenResponseFields` is called at `OP` line 1995, *before* `createRefreshToken` at line 2010, and the old token is only marked `revoked`/`rotatedAt` inside `createRefreshToken` (lines 1749-1752). An error thrown from the hook therefore leaves the presented refresh token untouched: not rotated, not revoked. If the hook does not revoke the family itself (the staleness branch should not, unlike the removal branch which does), then after the principal signs in at the provider again, **the very same refresh token is accepted** by the token endpoint, as long as it has not passed its own expiry (`refreshTokenExpiresIn`, default 30 days, `OP` line 1722).
- **Client side: most clients will not present it again.** `invalid_grant` is, for a standard OAuth client, the signal that the grant is dead: it discards its tokens and starts a new authorization (browser, provider sign-in, **no consent screen** because the `oauth_consent` row is still there). A client that instead keeps the token and retries later would succeed without any browser step. Which of the two a given MCP client does (claude.ai connectors, Claude Code, MCP Inspector) was **not tested** [unverified].
- **Why not revoke for staleness:** nothing was compromised, revoking gains no security (the 7-day check runs on every refresh anyway), and not revoking keeps the cheaper path open for clients that retry. Why still `invalid_grant` and not a softer error: no token-endpoint error means "retry later after the user signs in"; any other code would be mishandled or ignored.
- **So the spec scenario "Principal signs in again -> the client can obtain tokens again without a new consent" is met in both cases**; what differs is whether a browser round trip started by the client is needed. Design/spec should say: "the client's next authorization completes without a consent screen; a client that still holds its refresh token can use it again". Whoever writes the test should assert both: (a) same refresh token succeeds after a new provider sign-in, (b) a fresh authorization code flow issues tokens with no consent step.
- Removal of access is different on purpose: there the family **is** revoked (today's behaviour), and after restoration the client always needs a new authorization (still no consent screen).

### Magic link unreachable when STAGE is prod

**Do not register the `magicLink` plugin** on prod, rather than disabling its path:
- no plugin -> `/sign-in/magic-link` and `/magic-link/verify` do not exist (404), and no code can create a link, including through `auth.api`. `disabledPaths` would leave `auth.api.signInMagicLink` and the verify endpoint alive.
- the plugin adds no table (it uses `verification`), so the generated schema is the same on every stage.
- the allow-list reader, `ALLOWLIST_PARAMETER` and the IAM grant are not created on prod ("SHALL NOT read an allow-list"): `infra/web-env.ts` `webPlainEnvironment` sets the parameter for every stage today and `webDatabasePermissions` grants the read [repo].
- cost: `Auth = ReturnType<typeof createAuth>` [repo `auth.ts:211`] loses `api.signInMagicLink` when the plugin list is conditional; `requestMagicLink` in `sign-in.ts` needs a narrowed type. Small.
- test: build the prod configuration, POST to both magic-link paths, expect 404 and no `verification` row; assert the sign-in page has no email field.
- Config rule to add in `webConfigFromEnv` [repo `apps/web/src/config.ts`]: prod requires the provider settings and refuses `PRINCIPAL_ALLOWLIST` / `ALLOWLIST_PARAMETER`; dev and previews may have either or both.

---

## 3. administration

### Schema (simplest that fits)

On `user`, as Better Auth `additionalFields` (`input: false`), so `getSession` and the token hook get them for free and `pnpm --filter @a2h/web auth:schema` regenerates `auth-schema.ts` [repo header of `packages/db/src/auth-schema.ts`]:

| Column | Type | Meaning |
|---|---|---|
| `access_removed_at` | timestamptz null | null = has access. A timestamp instead of a boolean costs nothing and dates the state. |
| `is_administrator` | boolean not null default false | granted by an administrator's action only. |
| `last_idp_sign_in_at` | timestamptz null | section 2. Never shown on the administrators' page. |

Configured administrators are **computed, not stored**: administrator = `is_administrator` OR verified email in the configured list. That gives "remains one while the configuration names them" and "nobody else becomes one except through an administrator's action" with no synchronisation step.

`administrator_actions` in `packages/db/src/schema.ts` (ours, not generated): `action_id`, `actor_user_id`, `subject_user_id`, `action` (`access_removed | access_restored | administrator_granted | administrator_withdrawn`, check constraint), `created_at`. Append-only by the repo's existing trigger pattern [repo `packages/db/migrations/0001_append_only.sql`: UPDATE/DELETE raise `restrict_violation`]. Caution: `user` rows cascade on delete in the generated schema; the actions table must not cascade (nothing deletes users in this change; keep it so).

Each action is one transaction: check (not self, not last administrator) -> update `user` -> for removal delete the person's `session` rows and revoke live `oauth_refresh_token` rows -> insert the action row. A refused action writes nothing.

### Removal and the existing hook points [repo `apps/web/src/auth/auth.ts`, `consent.ts`]

The allow-list gate already sits at every point the spec names; the predicate changes from `isAllowed(email)` to "user has access":

| Point | Today | After |
|---|---|---|
| New session (`databaseHooks.session.create.before`, auth.ts:157-167) | allow-list | access state -> blocks sign-in after removal; redirect to the "contact an administrator" page |
| Any call carrying a session cookie (`allowlistGate`, auth.ts:79-100) | allow-list, deletes sessions | access state; belt and braces, since removal already deleted the sessions |
| Consent (`decideConsent`, consent.ts) | allow-list | access state |
| Token endpoint (`refuseRemovedPrincipal`, auth.ts:109-120) | allow-list, revokes refresh tokens, `invalid_grant` | access state (same), plus the 7-day rule (no revoke) |
| User creation (`databaseHooks.user.create.before`, auth.ts:146-155) | allow-list | `validateUserInfo` (email verified); allow-list only for magic-link users on dev stages |

"Ends sessions at once" holds because sessions are read from the database on every request (no cookie cache). "Earlier consents work again": removal must leave `oauth_consent` untouched; after restoration the client re-authorises without a consent screen. Access tokens (JWT, 1 h) keep working at the MCP service until expiry, as the spec states.

### Better Auth's `admin` plugin: gets in the way

- It adds `role`, `banned`, `banReason`, `banExpires` on `user` and `impersonatedBy` on `session` [src `BA/plugins/admin/schema.mjs`], and 15 HTTP endpoints: `/admin/ban-user`, `create-user`, `get-user`, `has-permission`, `impersonate-user`, `list-user-sessions`, `list-users`, `remove-user` (hard delete), `revoke-user-session(s)`, `set-role`, `set-user-password`, `stop-impersonating`, `unban-user`, `update-user` [src `BA/plugins/admin`; doc].
- Impersonation lets an administrator act as a person and so read their requests and answers: the opposite of "Administrators cannot see requests, answers or anyone's rules". The docs show no global switch to turn it off [doc].
- It has no record of actions, no last-administrator rule, names its fixed administrators by user id (`adminUserIds`), and its ban does not reach the OAuth provider's refresh grant; we would still write our own hooks.
- Verdict: three columns, one table and four server actions of our own are less code than fencing the plugin in.

---

## 4. Providers

| | Google Workspace | Okta | Microsoft Entra ID |
|---|---|---|---|
| Issuer | `https://accounts.google.com` (one issuer for all of Google); discovery `https://accounts.google.com/.well-known/openid-configuration` [doc] | Org server `https://{domain}`; custom server `https://{domain}/oauth2/{id}` (e.g. `default`) [doc] | `https://login.microsoftonline.com/{tenant-id}/v2.0` [doc: v2.0 issuer "ends in /v2.0"; URL form from Better Auth's helper, src] |
| `email_verified` | Yes with scope `email` [doc] | Yes with scope `email`: "true if the primary email is verified" [doc] | **No such claim** in the ID token claims reference [doc] |
| Stable subject | `sub`, "unique among all Google Accounts and never reused"; "Don't use the email field as a unique identifier" [doc] | `sub` | `sub` is immutable and pairwise per application; `oid` is the tenant-wide object id [doc] |
| Restrict to own people | App audience **Internal**: only members of the organisation; others get `org_internal` [doc] | App assignment: "Limit access to selected groups" or everyone in the org [doc]. That an unassigned user is refused was **not** stated on the page read. | "Single tenant only - <your tenant>" at registration [doc]. Guests of the tenant can still sign in; "Assignment required" on the enterprise app narrows further [unverified, not on the pages read]. |
| Groups for an OIDC client | **Not in the ID token**; needs the Admin SDK Directory API or Cloud Identity Groups API with separate credentials [search results only; unverified against Google's API docs] | `groups` claim with scope `groups` and a group filter on the app ("Matches regex"); org server: ID token only; custom server: a Groups claim on the server [doc]. One reference page says the claim is capped at 100 groups; the guide does not mention it. | `groups` optional claim (Token configuration > Add groups claim); object ids by default; over 200 groups the claim is replaced by an overage pointer to Microsoft Graph; "Groups assigned to the application" recommended for large tenants [doc] |

### Entra ID needs a decision

- Microsoft: the `email` claim "isn't guaranteed to be correct, and is mutable over time - never use it for authorization"; for members of the tenant it is only present when requested (optional claim or, on v2.0, the `email` scope) [doc].
- There is no `email_verified`. With the spec as written ("an email address the provider asserts as verified") **every Entra user is refused**.
- The documented signal is the optional claim **`xms_edov`** ("Boolean value indicating whether the user's email domain owner has been verified"; returned only together with `email`) [doc optional-claims-reference]. `verified_primary_email` is also listed but barely documented.
- Proposal for design: one more install setting, the name of the claim that asserts verification, default `email_verified`; the Entra runbook sets it to `xms_edov` and adds the optional claims `email` and `xms_edov` to the ID token (Token configuration > Add optional claim > ID). Identity stays `sub` (generic configuration), so no Entra-specific code. The alternative (Better Auth's `microsoftEntraId()` helper) switches the subject to `oid` and still yields "unverified".
- [unverified] Entra's default handling of unverified `email` claims on new registrations (`removeUnverifiedEmailClaim`): the Microsoft page could not be retrieved (the URL returned the hub page). Nobody has an Entra tenant to test `xms_edov` on; this stays "not validated" at Gate 2 unless the owner creates one.

### Google Workspace: registration steps for the dev stage (owner, Gate 2)

Prerequisite: a Google Cloud project that belongs to the Workspace organisation (Internal is only available then: "The project must be associated with a Google Cloud Organization") [doc].

1. Google Cloud console > **Google Auth Platform** > **Branding**: app name "A2H (dev)", user support email, save.
2. **Audience**: user type **Internal** (only members of your organisation can sign in; anyone else sees `org_internal`).
3. **Data Access**: scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. These are non-sensitive; no Google verification for an Internal app.
4. **Clients** (https://console.developers.google.com/auth/clients) > **Create client** > application type **Web application**; name "A2H dev".
5. **Authorized redirect URIs**: exactly `https://<dev web host>/api/auth/callback/idp`, where `<dev web host>` is the host of `AUTH_ISSUER` on dev. HTTPS, no wildcard, and "scheme, case, and trailing slash must all match" [doc]. No "Authorized JavaScript origins" needed.
6. **Create**; copy the client id and the client secret (the secret is shown once [doc]).
7. Give the PM: issuer `https://accounts.google.com` and the client id (not secret). Store the client secret as the dev stage's secret with the command the infra task will specify; it never goes in the repo, a PR or chat.
8. Check afterwards: sign in with a Workspace account -> lands signed in; sign in with a personal Gmail account -> Google refuses (`org_internal`).

Menu names under "Google Auth Platform" come from Google's help pages; the exact wording of each screen was not seen [unverified]. The `hd` claim (Workspace domain) is the documented way to check the organisation in the token ("validate that the returned ID token has an hd claim value that matches what you expect") [doc]; with an Internal app Google already refuses outsiders, so a `hd` check is optional hardening (a generic "required claim" setting), not needed for Gate 2.

---

## 5. Testing

### Keycloak as the upstream provider

- Image `quay.io/keycloak/keycloak:26.8.2` (the version on keycloak.org's Docker guide today; pin by digest as CI does for actions), env `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD`, command `start-dev --import-realm`, realm file mounted at `/opt/keycloak/data/import/a2h-test-realm.json` (file name `<realm>-realm.json`; an existing realm is skipped; startup waits for the import) [doc]. `start-dev` together with `--import-realm` is common practice but was not stated on the page read [unverified].
- The realm export in the repo (suggested `apps/web/test/lib/keycloak/a2h-test-realm.json`) holds: one confidential client (`a2h-test`, a fixed test secret, redirect URI `http://localhost:*/api/auth/callback/idp`), and users: one with a verified email, one with `emailVerified: false`, one without an email, a second verified user for the administrator flows. No real addresses.
- Same pattern as Postgres today: `apps/web/test/lib/postgres.ts` starts a throwaway `postgres:17` container from vitest's global setup and skips without Docker unless `A2H_DB_PG_REQUIRED=1` [repo]. A sibling `keycloak.ts` does the same (port on 127.0.0.1, wait for `/realms/a2h-test/.well-known/openid-configuration`). CI: pull the image where `postgres:17` is pulled today [repo `.github/workflows/ci.yml:111`] (CI is QA's). Keycloak in dev mode takes some tens of seconds to start [unverified]; one container per test run.
- Driving the flow without a browser in vitest: call `auth.api.signInSocial`, follow the authorize URL with `fetch` and a cookie jar, post Keycloak's login form, follow the redirect to our callback handler. Negative cases (wrong issuer, wrong audience, wrong nonce, replayed state) are easier with a tiny in-process fake issuer signing its own tokens than by bending Keycloak; both are worth having: Keycloak proves interoperability, the fake proves each refusal.
- Time: the 12 h and 7 day scenarios need an injectable clock in our hooks (the allow-list already takes `now` [repo `allowlist.ts`]), and for Better Auth's own session expiry either vitest fake timers or a direct update of `session.expires_at` / `last_idp_sign_in_at` in the test.
- Email change at the provider: Keycloak's admin REST API can change a user's email between two sign-ins.

### Previews stay magic-link only

Yes, and they have to:
- every preview has its own host, and Google/Okta/Entra want each redirect URI registered exactly;
- the deployed preview Lambda cannot reach a Keycloak running on the CI runner;
- the spec allows it ("next to the identity provider *when one is configured*").

So: provider scenarios run in vitest against Keycloak (CI job, no deployment); the existing Playwright flows keep using magic links on previews and dev [repo `apps/web/playwright.config.ts`, `preview.yml`, `deploy.yml`]; the administrators' page can be driven end to end on a preview with magic-link users (administrators named by email in the preview's configuration). A Playwright run against a local `next start` + Keycloak is possible (the config already defaults to `http://localhost:3210`) but is new CI work for QA; say in design whether it is wanted. The real-provider run is the owner's Gate 2 on dev with Google.

---

## 6. What is harder than the proposal assumes, and scenarios at risk

### Harder than assumed

1. **Two gates on dev stages.** Every gate today asks "is this email on the allow-list" (`auth.ts` database hooks, `allowlistGate`, `refuseRemovedPrincipal`; `consent.ts`). With a provider configured on dev, a provider user who is not on the allow-list would be refused by the same hooks, and the kept scenario "Address removed from the allow-list" must still stop magic-link users within five minutes. The gate must know how the person got in. Simplest rule: the allow-list applies to users with no `account` row for provider `idp`; access state applies to everyone. Needs a line in design.
2. **Verification method per person on dev.** `owner_allowlist` or `organisation_idp` must follow the sign-in that led to the consent; a dev user can have used both. Same rule as above, or a session field recording the method. `ensurePrincipal` must receive it.
3. **The 7-day rule and magic-link users.** They never sign in at a provider, so `last_idp_sign_in_at` is null and every refresh would be refused: all existing CI flows and the owner's current agents on dev would break. The rule must apply only to users who have a provider account (or the column records any sign-in). Existing users also need a defined value at migration.
4. **Implicit linking by email** (section 1): a security decision, not a detail. Recommended off in production.
5. **`/sign-in/social` accepts a raw ID token** (section 1): must be closed.
6. **Provider tokens in `account`** (section 1): must be stripped; otherwise the schema comment and the "tokens stored hashed" posture of ADR 0004 become false for this table.
7. **Per-transaction Better Auth instance at consent** would refetch discovery (section 1).
8. **Discovery at cold start**: one outbound HTTPS call to the provider per Lambda instance; if it fails the provider is absent until a request retries it (10 s timeout). The sign-in page needs an "identity provider unreachable" state; Design should know. The web Lambda is outside the VPC (ADR 0004 decision 7), so reaching the provider needs no network change.
9. **`packages/db`**: regenerated auth schema, three columns, one table with trigger, the verification-method constraint, `ensurePrincipal`. Ownership of `packages/db` changes is not stated in my role file; the PM assigns.
10. **Infra**: the web Lambda needs the issuer, client id, client secret (stage secret) and the administrators' list; prod must stop receiving `ALLOWLIST_PARAMETER` and its IAM grant. `infra/` is not mine.
11. **Email collision on change**: if the provider reports a new email that another A2H user already has, `updateUser` hits the unique constraint and Better Auth does not catch it (the `overrideUserInfo` update at `link-account.mjs` ~line 240 is outside a try block) [src]. Needs a defined outcome (refuse with the administrator page), probably by checking in `validateUserInfo` on `sign-in`.
12. **Type of `Auth`** with a conditional plugin list (magic link absent on prod): small, but touches `sign-in.ts` and tests.

### Scenarios that cannot be met as written, or need wording

- **"an email address the provider asserts as verified" with Microsoft Entra ID**: not as written; needs the configurable verification claim (`xms_edov`) or an explicit exception. Google and Okta are fine.
- **"Principal signs in again -> the client can obtain tokens again without a new consent"**: met, see the clarification in section 2. No new consent in any case; whether the client needs a browser round trip depends on whether it kept its refresh token after `invalid_grant`. Suggest wording: "the client's next authorization completes without a consent screen, and a refresh token it still holds works again".
- **"Session reaches twelve hours -> sent to sign in at the provider again"**: met, but if the provider still has its own session the person is signed back in without typing anything. "Vouches" then means "the provider still has a session for them", not "re-authenticated". Forcing re-authentication (`prompt: "login"` or `max_age` via `authorizationUrlParams`, both available in the plugin [src types.d.mts]) is possible but may not be honoured identically by all three providers [unverified]. Decide whether silent re-entry is acceptable; it is the usual SSO behaviour and it does end access for a leaver whose provider account is disabled.
- **"Answer … one already used"**: met for the redirect flow; only if `/sign-in/social` is closed over HTTP (item 5).
- **"Returning person is recognised by the provider's identifier" with Entra**: the generic `sub` is per application: re-registering the application in Entra gives everyone a new subject and, with linking off, locks them out. Runbook note.
- **Last administrator**: because configured administrators are always administrators, "no administrator left" can only arise among people who have signed in. Clarify whether the rule counts configured addresses that have never signed in (suggest: count only administrators who exist as accounts and have access).
- **Removing a configured administrator's access**: the spec forbids removing one's own access but not another administrator's, including one named in the configuration. Allowed? If yes, access state must win over the configuration (a removed person is not an administrator).
- **Administrators named by email**: an address in the configuration that is later reassigned at the provider makes its new holder an administrator. Inherent in naming by email; say so in the runbook.
- **"The administrators' page SHALL NOT show when a person was last active"**: we store `last_idp_sign_in_at`; it must never be selected by the page's query. A test should assert the selected columns.
- **"Access removed -> their next sign-in at the provider is refused by A2H with a page telling them to contact an administrator"**: `databaseHooks.session.create.before` returning `false` yields a generic failure; to land on the right page the refusal should come from `validateUserInfo` (action `sign-in`) with its own error code. Feasible; noted so the page gets a distinct code.

### Not verified (summary)

- Nothing was run: no flow against Keycloak, Google, Okta or Entra; no test exists yet.
- Context7 unavailable; vendor pages and installed source used instead.
- `ctx.context.newSession` in an `after` hook on the callback route.
- MCP clients' behaviour on `invalid_grant` at refresh (discard vs. retry).
- Entra: `removeUnverifiedEmailClaim` defaults; `xms_edov` in practice; "Assignment required".
- Okta: that unassigned users are refused; the 100-group cap.
- Google: the group APIs; exact console wording.
- Keycloak: `start-dev --import-realm` together; start-up time in CI.
- `prompt=login` / `max_age` support per provider.

### Sources

- Better Auth 1.7.14 source (roots above): `plugins/generic-oauth/{index.mjs,types.d.mts,providers/*}`, `api/routes/{callback,sign-in,session}.mjs`, `api/index.mjs`, `oauth2/{callback,link-account,account-key,state,errors,utils}.mjs`, `state.mjs`, `utils/validate-user-info.mjs`, `db/internal-adapter.mjs`, `context/create-context.mjs`, `cookies/index.mjs`, `plugins/admin/*`; `@better-auth/core` `oauth2/verify-id-token.mjs`, `types/init-options.d.mts`; `@better-auth/oauth-provider` `authorize-B1Bc3IL6.mjs`.
- https://www.better-auth.com/docs/plugins/generic-oauth , /docs/plugins/sso , /docs/plugins/admin , /docs/concepts/session-management , /docs/concepts/users-accounts
- https://developers.google.com/identity/openid-connect/openid-connect , https://developers.google.com/identity/protocols/oauth2/web-server , https://support.google.com/cloud/answer/15549945
- https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference , /optional-claims-reference , /optional-claims , /quickstart-register-app
- https://developer.okta.com/docs/api/openapi/okta-oauth/guides/overview/ , https://developer.okta.com/docs/guides/customize-tokens-groups-claim/main/ , https://help.okta.com/en-us/content/topics/apps/apps_app_integration_wizard_oidc.htm
- https://www.keycloak.org/server/importExport , https://www.keycloak.org/getting-started/getting-started-docker
