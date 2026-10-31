# Design

## Context

See proposal.md "Why". What shapes the approach:

- The MCP server (`apps/mcp`) is `node:http` plus `createMcpHandler` and `toNodeHandler` from the v2 SDK, one `McpServer` per request, stateless; the approval state codec is bound to a principal id that today comes from the service environment (`PRINCIPAL_*`, infra/service-env.ts). The worker re-validates at delivery with the same environment.
- `apps/web` is Next.js 15 on CloudFront + Lambda through OpenNext (ADR 0001). Its Lambda runs outside the VPC and is not linked to Aurora (ADR 0001 amendment 3: the owner was to choose between a NAT instance and database access through the services). The deploy already uses the Aurora Data API from CI for migrations and the seed (`db-migrate.sh`), so the Data API is enabled on the dev cluster.
- `infra/` already derives hostnames and switches the load balancer to HTTPS when `domain` is set (config.ts, cluster.ts, web.ts); nothing else is needed for TLS besides the hosted zone.
- The 2026-07-28 authorization chapter: resource server with 401 challenge, path-aware protected-resource metadata, audience validation (RFC 8707), CIMD recommended and DCR deprecated, PKCE S256 mandatory, `iss` parameter recommended. `@modelcontextprotocol/server` 2.4.0 ships the resource-server side (`requireBearerAuth`, `verifyBearerToken`, `bearerAuthChallengeResponse`, `oauthMetadataResponse`, `OAuthTokenVerifier`, `AuthInfo` with `resource`, `scopeChallenge` per tool) and deliberately issues no tokens; the v1 authorization-server helpers are frozen in `server-legacy`.
- Better Auth 1.7.14 with `@better-auth/mcp` and `@better-auth/cimd` implements the authorization server: RFC 8414 and OIDC discovery, `/oauth2/authorize|token|consent|register|introspect|revoke`, CIMD with an SSRF-hardened fetcher, DCR (off by default), PKCE required, `resource` → JWT `aud`, JWT access tokens signed with keys published at a JWKS URL, rotated refresh tokens, consent records. Its Drizzle adapter takes any Drizzle database, including the Data API driver.
- Hosted clients (research, 2026-10-29): claude.ai needs a real 401 with `resource_metadata`, uses the first authorization server only, uses CIMD when the metadata advertises it with `none` auth, else DCR; callback `https://claude.ai/api/mcp/auth_callback`; 10 s on OAuth endpoints; egress `160.79.104.0/21`; tool calls capped at 240 s. Claude Code has its own CIMD document and loopback redirects. Whether claude.ai renders the `input_required` form is not documented anywhere.

## Goals / Non-Goals

**Goals:**
- One trust relationship per stage: the stage's authorization server issues tokens whose audience is the stage's MCP URL; the MCP server verifies them with no network call on the hot path.
- The principal of a tool call is a fact of the token, never of the deployment; the worker and the MCP server agree on where a principal's policy lives.
- Every public path is limited; the limit that matters is per principal and holds across instances.
- Everything settable by the owner (domain, allow-list, limits) is configuration, not code.
- Previews are self-contained: own hostnames, own authorization server, own tokens.

**Non-Goals:**
- Prod deploy, open sign-up, the contact-policy screen, wallet, DPoP, enterprise-managed authorization, client-credentials, directory listings (proposal "Out of scope").
- A general email system: one template, one sender, one sink.

## Decisions

### D1. The authorization server is Better Auth in `apps/web`
Issuer `https://<web host>/api/auth` (dev: `https://dev.<domain>/api/auth`; preview: `https://pr-<n>.dev.<domain>/api/auth`). Plugins: `jwt` (EdDSA keys in the `jwks` table, JWKS at `/api/auth/jwks`), `mcp` (`resource` = the stage's MCP URL, `loginPage` and `consentPage` in the app, `allowDynamicClientRegistration: true`, `clientRegistrationDefaultApplicationType: "native"` so loopback redirects of CLI clients pass), `cimd` with the Node fetcher and `metadataProfile: "mcp-2026-07-28"`, `magicLink`. Scopes: `a2h` (the tools) and `offline_access` (refresh); the protected-resource metadata lists `a2h` only, as the specification asks. Pre-registered clients come from stage configuration for hosts that need a secret.
Why over alternatives: Better Auth is the library CLAUDE.md names for the product, so participants (M2) and principals share one sign-in; an external IdP adds a vendor, a bill and an EU-residency question; the SDK's own authorization server is deprecated. Hosting it in the MCP service would put HTML sign-in and consent screens inside `apps/mcp`, across the ownership boundary between Protocol-dev and Web-dev.
Recorded in ADR 0004 with the token format (signed JWT, one hour, audience-bound) and the decision that access tokens are not individually revocable: revocation acts on refresh tokens and consents, and the short lifetime bounds the exposure.

Group 5 facts (PR #58): Better Auth 1.7.14 with `@better-auth/mcp` (the OAuth provider configured for MCP; not deprecated, never combined with a separate `oauthProvider`). It emits the RFC 9207 `iss` parameter on every authorization response, success and error, and advertises `authorization_response_iss_parameter_supported: true`. `refreshTokenReuseInterval` is set to 0: the mcp plugin's default of 30 s answers a replayed refresh token with the earlier response instead of refusing it, and spec "Refresh token replayed" requires the replay to be refused and the family revoked. Better Auth records no last use per client, so Connected apps shows "Connected {date}" only. Its tables (user, session, account, verification, jwks, oauth_client, oauth_resource, oauth_client_resource, oauth_access_token, oauth_refresh_token, oauth_consent, oauth_client_assertion) are generated by its CLI into `packages/db/src/auth-schema.ts` and migration 0006. On the Data API the schema is chosen by the login, never by a statement: previews log in as `pr_<n>`, whose role sets `search_path = pr_<n>`; dev as the master user (`public`); the web app checks `current_schema()` against `DB_SCHEMA` once per cold start. The sign-in action answers in constant time for known and unknown addresses (a floor of 800 ms raised by the observed duration of real work).

### D2. The web Lambda reaches Aurora through the Data API
`apps/web/infra` builds a Drizzle database on the Data API driver (`drizzle-orm/aws-data-api/pg` with `@aws-sdk/client-rds-data`), authorised by the Lambda's task role on the cluster ARN and the stage's database secret, scoped to the stage's schema; no password in the function's environment, no VPC attachment, no NAT gateway. This is the same path CI uses for migrations. It resolves ADR 0001 amendment 3 (recorded as amendment 4) and answers the prod-migration question from the previous change the same way: the prod cluster gets the Data API enabled in `infra/database.ts` now (a cluster setting, no deploy of prod services), so the first prod deploy can migrate from CI as dev does.
Alternatives: a NAT instance and the Lambda in the VPC (a monthly cost and a single point of failure for the web tier); database access only through the MCP and worker services (an internal API to build and secure for two tables of sign-in state).
Trade-off: Data API latency (tens of milliseconds per statement) and a 1 MiB response limit; sign-in, consent and token issuance are the only web paths that touch the database in this change.

### D3. The MCP server is a resource server with the SDK's gate
In `apps/mcp/src/app.ts`, before `handler.fetch`: `oauthMetadataResponse` answers the path-aware protected-resource metadata (`/.well-known/oauth-protected-resource<mcpBasePath>`, `resource` = the stage's MCP URL, `authorization_servers` = [issuer], `scopes_supported` = [`a2h`], `bearer_methods_supported` = [`header`]); the health path and the metadata bypass the gate; every other request on the MCP path passes `requireBearerAuth({ verifier, requiredScopes: ["a2h"], resourceMetadataUrl, expectedResource })`, and the resulting `AuthInfo` goes to `handler.fetch(request, { authInfo })`. The verifier uses `jose` `createRemoteJWKSet` on the issuer's JWKS URL (cooldown 60 s, cache 10 min), checks `iss`, `aud` (exactly the stage's MCP URL, set as `AuthInfo.resource`), `exp` (set as `expiresAt`), `scope`; the subject becomes `AuthInfo.extra.principal_id`. Any failure is `OAuthError(InvalidToken)`, so the SDK answers 401 with the challenge; a missing scope is 403 `insufficient_scope`.
`ping` is registered without a scope requirement so the connectivity check and the idle-stream proof stay open; the three A2H tools require `a2h`. Because `ping` sits behind the same endpoint, an unauthenticated `tools/call` of `ping` must still pass the gate: the gate admits a request with no token only when its body is a `ping` call or a handshake for `ping` alone is not expressible, so the decision is: `ping` reachable without a token on the handshake and `tools/call` when the stage's `PING_OPEN` setting is true (dev and previews, for QA), false on prod. Spec `connector-authorization` "Open paths stay open" names this.
Per-request principal: the `McpServerFactory` receives `ctx.authInfo`; `toolDeps` is built per request with the principal loaded from the `principals` table (D4), and the approval codec's `bind` returns that principal id, so a state minted for one account fails for another (existing behaviour, now per token).

### D4. Principals are rows, policies travel with them
`packages/db` gains `principals` (id = Better Auth user id, `identity_mode` default `real_name`, `verified` default false, `created_at`) and `principal_policies` (one row per principal with the fields of today's `DEVELOPMENT_POLICY`, copied from the stage's configured default on first consent). The MCP server loads both per request; the worker loads them at delivery (its `PRINCIPAL_*` environment goes away with the MCP server's). `apps/web` creates the rows in the consent step, inside the transaction that records the consent. Until the principal surface (M5) there is no screen to edit a policy; the stage default is the policy.
Why rows rather than claims in the token: a policy change must apply to the next call, not after the token expires; the worker needs it without a token.
Group 3 (PR #54) facts: `principal_id` is the opaque-id shape of `PrincipalSchema` (varchar 64, so Better Auth's 32-character ids fit and a stored id always parses); `fee_rate` is the platform's rate and is not stored per principal (callers add the stage rate to build a `ValidationPolicy`); the Better Auth tables are generated by group 5 with its CLI; pruning stale dynamic clients moves to group 5 or 7 since those rows are Better Auth's. Open for later: a check `throttled_daily_limit <= daily_request_limit` once the protocol schema enforces it; what erasure (30 days, PRD §11) does to `principal_policies` and `rate_limit_windows`, whose foreign keys are NO ACTION.

### D5. Limits
- Edge: an AWS WAF web ACL with a rate-based rule on the MCP and `/api/auth` paths, associated with the ALB (regional scope, eu-west-3) and with the web CloudFront distribution (CloudFront scope, which AWS requires in us-east-1: the second exception to ADR 0001's one-region rule, like ACM for CloudFront, holding no data). The limit per stage comes from `infra/config.ts` (default 600 requests per 5 minutes per address). Health is excluded. Previews share dev's ALB and its web ACL.
- Per principal: a `rate_limit_windows` table (`principal_id`, `window` = minute or day start, `count`), one upsert per tool call before validation (`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`), compared with the stage's limits (defaults 60 per minute, 2,000 per day). Over the limit: a `ProtocolError` `rate_limited` with `retry_after_seconds`, nothing else written. Windows older than a day are deleted by the worker's expiry job. Shared across instances because it is in Postgres; one statement per call. Window starts are checked to lie on their UTC boundary (`rateLimitWindowStart` in `packages/protocol`), so two instances never count the same minute in two rows; the day window is the UTC day, as the interruption count already is.
- Held pings: an in-process counter capped by `PING_MAX_CONCURRENT` (default 4) per instance; the cap is per instance by design, since a held connection is a resource of the instance holding it.
- Group 7 (PR #56) decisions: the per-principal limit is an error result with code `rate_limited` and `retry_after_seconds` (the proposal's "429 and Retry-After" applies to the edge only); `ping` is not counted; test stages (dev and previews) run 600 a minute and 20,000 a day because the verification suites act as one principal, prod keeps 60 and 2,000; `PING_OPEN` is true off prod until task 8.3 gives the verify job a token, then dev turns it off so hosted clients meet the 401 on the handshake; previews run `AUTH_REQUIRED=false` until 8.3 (TODO in `service-env.ts`); the seed creates the fallback principal `dev-principal-<stage>` for the gate-off path; at delivery a missing principal row fails closed with `principal_not_accountable` and no `blocked_manifests` row (not a participant rule). The ALB must forward `/.well-known/oauth-protected-resource/<mcp path>` to the mcp service (task 8.1), or the challenge points at a URL the service never receives.
- Group 8 (tasks 8.1, 8.2) facts: the limits are `limitsFor(stage)` in `infra/config.ts`: dev and previews 600 calls a minute and 20,000 a day, prod 60 and 2,000, 4 held pings everywhere. The ALB routes `/.well-known/oauth-protected-resource/mcp` (priority 49003) and `/.well-known/oauth-protected-resource/pr-<n>/mcp` (20000 + n, a second band, so PR numbers stop at 19899). The WAF path condition (open question below) is one regular expression on the URI path, after URL decoding and path normalisation, covering `/mcp` and `/pr-<n>/mcp` with subpaths, the three well-known discovery documents and `/api/auth` with subpaths; health and pages are never counted; 429 when over, request sampling off (D10).
- Edge limit per stage: prod 600 requests per 5 minutes per address (the owner's default); dev 3,000, because dev's verification runs and every preview's come from one runner address each and all count against dev's web ACLs (previews create none and inherit dev's).
- The CloudFront web ACL reaches the Next.js distribution through a `$transform` on `sst.aws.Cdn` named `WebCdn` (`infra/waf.ts` `attachWebAcl()`), so `infra/web.ts` is unchanged.
- Previews read dev's CloudFront ACL from `/a2h/shared/web-acl-cloudfront-arn` only when it exists (`PR_STAGE_OPTIONAL_READS`), and deploy with no ACL on their distribution before dev has published it; the read becomes strict once dev has.
Alternative rejected: in-memory per-instance limits for principals (not shared across instances, spec "Limit shared across instances").

### D6. Magic links on non-production stages go to a mail sink
`packages/email` gets its first template (magic link; React Email) and a `Mailer` interface with two implementations: SES (prod) and an S3 sink that writes `{to, subject, text, html, sent_at, id}` under `tmp/<stage storage prefix>mail/<ulid>.json` in the existing bucket (the `tmp` area, so the 7-day lifecycle rule expires sink messages and a preview's existing `<area>/pr-<n>/*` grant covers it with no new infra rule; decided with group 6, PR #53), readable only through the deploy role (QA's Playwright helper and the owner through the CLI line in the package README). Nothing on a non-prod stage can send email, by construction. The allow-list means a sink object never contains an unknown person's address.

Group 6 findings: the template's call to action is a plain underlined link because `packages/ui` has no tokens yet and no colour may be written outside it (a test forbids colour values in the email HTML); Design reviews the copy and supplies the button when tokens exist. The sender address comes from the `emailSender` shared parameter already listed in `infra/config.ts`.

### D7. Allow-list and other owner-settable values
Allow-listed addresses live in an SSM SecureString parameter per environment (`/a2h/shared/principal-allowlist` for dev and previews, `/a2h/prod/principal-allowlist` for prod), created empty by the deploy and set by the owner with one CLI line (runbook). The web app reads it at cold start and refreshes it every five minutes. The domain stays in `infra/config.ts`; the limits and `PING_OPEN` are stage configuration next to the development policy.

### D8. Clients
CIMD and DCR both enabled (spec "Clients register…"); the authorization-server metadata advertises `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported` including `none`, `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported: true` (verified against Better Auth during task 3; if Better Auth does not emit `iss`, the gap is recorded and the claim removed). Verified in group 5: Better Auth emits `iss`. No OpenID Connect discovery in M1: `<issuer>/.well-known/openid-configuration` returns 404, because the server is OAuth-only (scopes `a2h` and `offline_access`, no `openid`; Better Auth serves the OIDC document only when `openid` is a scope). MCP clients read the RFC 8414 document first, and it carries everything listed here; adding `openid` would first need a plain-words line for it on the consent screen. Dynamic registrations older than 30 days without a token are pruned by the worker. Pre-registered clients (id, redirect URIs, optional secret hash) come from stage configuration for hosts that cannot use CIMD or DCR.

### D9. Order of work: domain, TLS, spike, then authorization
Nothing hosted can be tried before TLS, and the claude.ai approval-form question decides the shape of Gate 2, so the order is: hosted zone and `domain` (owner, then one infra PR); claude.ai connector spike on dev with "No sign-in", driving `request_human` to the approval; decision 6 of the proposal; then the authorization build, which does not depend on the spike's answer.

### D10. Logging and records
Tokens, magic links, emails and client secrets never appear in logs or rows (spec "Tokens are never forwarded"). Log lines carry the opaque principal id, the client id and the request id. Better Auth's own logger is set to the structured logger with its default `info` lines on auth events only.

## Screens (Design agent, after Gate 1)

Five screens in `apps/web`, all built from `packages/ui` (`@a2h/ui`); the web dev composes them and owns routing, server actions and data. Every screen and state below exists as a component and a Storybook story (`packages/ui/src/screens/Screens.stories.tsx`, "Screens/…"); the copy below is the copy in `packages/ui/src/screens/copy.ts`, and the two change together.

### S0. Foundations used, and what is provisional

- **No palette is chosen here.** `packages/ui` had no tokens yet, and the primitive ladder (warm neutral, accent hue, status hues) belongs to `m2-design-foundations` and its owner checkpoint (ADR 0003, Consequences). This change adds the **semantic tier only** (`packages/ui/src/tokens/tokens.css`), with every role resolved to a CSS system colour (`Canvas`, `CanvasText`, `LinkText`) or a `color-mix` of them. The browser supplies the values in both themes; no hex or OKLCH value exists in the package, and a test enforces it (`test/tokens.test.ts`). When the foundations change lands it replaces the right-hand sides of `tokens.css`; no component, story or screen changes.
- Consequences until then, accepted for M1 (dev and previews only, no prod): the accent is the browser's link colour; the four status triplets share one neutral derivation, so status is carried by the notice title in words (which the skill requires anyway, §3.2); the typeface is the system stack (`--font-sans`, `--font-mono`).
- Roles used: `--surface`, `--surface-2`, `--text`, `--text-muted`, `--border`, `--border-strong`, `--accent`, `--on-accent`, `--focus`, `--danger-*`, `--success-*`, `--neutral-*`; spacing `--space-1…8` (4/8/12/16/24/32/48/64), radius `--radius-md` (controls) and `--radius-lg` (notices, identity block), `--target-min` (44 px), `--measure` (62ch), type steps `--text-xs…xl` with line heights on the 4 pt grid, motion tokens only under `prefers-reduced-motion: no-preference`.
- Base layer: React Aria Components (ADR 0003 D1) for every control (`Button`, `Link`, `TextField`/`Input`/`Label`/`FieldError`), CSS modules on semantic roles (D8).
- Theme: `prefers-color-scheme`, overridable with `data-theme="light|dark"` on `<html>` (skill §2.3). The app imports `@a2h/ui/tokens.css` and `@a2h/ui/base.css` once in the root layout.

### S1. Components (packages/ui)

| Component | Used by | Notes |
|---|---|---|
| `AuthShell` | all five | header with the text wordmark "A2H"; optional account area ("Signed in as {address}" + ghost **Sign out**, a `POST` form); optional one-line stage notice; one `<main>` column (480 px, 640 px for Connected apps). |
| `Button`, `ButtonLink`, `TextLink` | all | React Aria `Button`/`Link`. Primary = solid `--accent` with `--on-accent`; ghost = `--accent` text, `--border-strong` edge. 44 × 44 px minimum. `isPending` swaps the label for a pending label and marks the button busy. `TextLink` is underlined, so a link is never confused with accent-coloured machine text. |
| `TextField` | sign-in | visible `<label>`, description and error wired by React Aria (`aria-describedby`, `aria-invalid`); error text prefixed "Error:"; 16 px input text (no zoom on iOS). |
| `Notice` | all | tones `danger`, `success`, `pending`, `neutral` (status triplets) and `platform` (A2H note, title in `--accent`). A title is required: the status is always in words. Optional `reference` (request id, mono role). `live`: `alert` for an error after an action, `status` for a confirmation, none for content present on load. |
| `ClientIdentity` | consent | machine-origin block (below). |
| `ClientRow` | connected apps | one app with the inline revoke confirmation (below). |
| `Skeleton` | connected apps loading | `--surface-2` block, `aria-hidden`; pulses only without reduced motion. |
| Screens | `SignInScreen`, `CheckEmailScreen`, `LinkExpiredScreen`, `ConsentScreen`, `ConnectedClientsScreen`, `SignedOutScreen` | presentational; take a `state` prop, form `action`s (URL or server action) and preformatted data. |

**Colour roles on these screens (skill §3).** The only human words here are the principal's own address, shown plain (`--text`, weight strong). Machine-origin content, meaning everything the *client* declares about itself, takes the machine role: the client's name in `--accent` (never underlined, never a link), the host it is identified by in the mono role, and how A2H knows it in words beneath. Platform notes ("You still approve every question") use `Notice tone="platform"`. Every control takes `--accent`. No second hue.

### Routes

| Route | Screen | Reached from |
|---|---|---|
| `/sign-in` | S2 Sign in | Better Auth `loginPage`; direct. Query `next` (the authorize URL to resume) is kept in a hidden field. A signed-in visitor is redirected to `next` or `/account/clients`. |
| `/sign-in/sent` | S3 Check your email | after the sign-in form posts. The address comes from the form's server action state or a short-lived, HttpOnly flash cookie: **never from the URL** (no PII in URLs or access logs). |
| `/sign-in/expired` | S3b Link no longer works | the magic-link verify endpoint's `errorCallbackURL` for an expired or used link, keeping `next`. |
| `/consent` | S4 Consent | Better Auth `consentPage`. |
| `/account/clients` | S5 Connected apps | after sign-in without `next`; link from consent. Signed-out visitors go to `/sign-in?next=/account/clients`. |
| `/signed-out` | S6 Signed out | after the sign-out `POST` revokes the session. |

Document titles: "Sign in · A2H", "Check your email · A2H", "Sign-in link no longer works · A2H", "Connect {client} · A2H", "Connected apps · A2H", "Signed out · A2H".

On a non-production stage every screen shows one line under the header: **"Test stage {stage}. Not the live service."** (`AuthShell stageName`). Prod never passes `stageName`; no copy anywhere says "development" (test `copy.test.ts`).

### S2. Sign in (`/sign-in`)

```html
<AuthShell [stageName]>
  <h1>Sign in to A2H</h1>                                   <!-- --text-xl, --text -->
  <p class="lead">{lead | leadConnecting}</p>               <!-- --text-md, measure 62ch -->
  [<Notice tone=danger|neutral live=alert|status>]           <!-- error, rate-limited, offline -->
  <form method=post action={requestMagicLink} novalidate>
    [<input type=hidden name=next>]
    <TextField label="Email address" name=email type=email autocomplete=email required [errorMessage]/>
    <Button type=submit primary fullWidth isPending pendingLabel>Email me a sign-in link</Button>
  </form>
  <p class="muted">A2H is open to invited addresses only for now.</p>   <!-- --text-sm, --text-muted -->
</AuthShell>
```

Copy:
- h1 **Sign in to A2H**
- lead **Enter your email address and we'll send you a link to sign in. There is no password.**
- lead when `next` is present (an agent started the connection): **Sign in to finish connecting your agent. We'll email you a link; open it in this browser to come back here.**
- label **Email address**; button **Email me a sign-in link**, pending **Sending the link…**
- footnote **A2H is open to invited addresses only for now.** (shown to everyone, before submission; see open question 1)

States:
- **Empty**: the form above, focus not forced (the page's first focusable is the field after the header).
- **Submitting**: button shows "Sending the link…", busy, not pressable twice. No spinner-only state.
- **Invalid** (client or server validation): field error **Error: Enter your email address.** or **Error: Enter an email address in the form name@example.com.**; focus returns to the field; the address typed is kept.
- **Error** (server failure): `Notice danger` **The link was not sent** / "Something went wrong on our side. Your address is still in the field; try again." + Reference {request id}; `role=alert`.
- **Rate limited** (429 from the auth endpoint or the edge): `Notice danger` **Too many attempts** / "Too many sign-in links were asked for from here. Wait a few minutes, then try again."
- **Offline** (submission fails with no network, or `navigator.onLine` is false at submit): `Notice neutral` **You're offline** / "Your address is kept. Send the link when you're back online."
- **Allow-listed or not**: there is no state for it. Both go to S3 with identical markup (spec "Unknown address"; test `screens.test.tsx`).
- **Already signed in**: redirect, no screen.

### S3. Check your email (`/sign-in/sent`)

```html
<AuthShell [stageName]>
  <h1>Check your email</h1>
  [<Notice tone=neutral title="On this test stage, links are not emailed">]   <!-- non-prod only -->
  <p class="lead">If <strong>{address}</strong> can sign in to A2H, a sign-in link is on its way to it.</p>
  <p>The link works once and for 15 minutes. Open it in this browser.</p>
  <p class="muted">Nothing after a few minutes? Check your spam folder, or send another link.</p>
  [<Notice tone=success|danger|neutral>]                    <!-- resent, error, offline -->
  <form method=post action={requestMagicLink}>              <!-- same address, same next -->
    <Button ghost type=submit>Send another link</Button>
    <ButtonLink ghost href="/sign-in[?next]">Use a different address</ButtonLink>
  </form>
</AuthShell>
```

Copy:
- h1 **Check your email**
- **If {address} can sign in to A2H, a sign-in link is on its way to it.** The address is the one the person typed, plain text, weight strong. Without it (reload after the flash cookie expired): **If your address can sign in to A2H, a sign-in link is on its way to it.**
- **The link works once and for 15 minutes. Open it in this browser.**
- **Nothing after a few minutes? Check your spam folder, or send another link.**
- ghost **Send another link** (pending **Sending…**), ghost link **Use a different address**
- non-prod only, `Notice neutral`: **On this test stage, links are not emailed** / "The link is kept in this stage's mail sink. The runbook shows how to read it." (spec "Preview sign-in"; D6)

States:
- **Sent** (default) and **resending** (pending label).
- **Resent**: `Notice success`, `role=status`: **Another link is on its way** / "Use the newest one. It works once and for 15 minutes." Whatever the address, the same notice (unknown addresses still create nothing).
- **Error**: `Notice danger` **Another link was not sent** / "Something went wrong on our side. Wait a moment and try again." + reference.
- **Offline**: `Notice neutral` **You're offline** / "You can send another link when you're back online."
- **Loading / empty**: none; the page is server-rendered with its content.

#### S3b. Link no longer works (`/sign-in/expired`)

```html
<AuthShell [stageName]>
  <h1>This sign-in link no longer works</h1>
  <p class="lead">A sign-in link works once and for 15 minutes. This one has expired or was already used, so you are not signed in.</p>
  <ButtonLink primary fullWidth href="/sign-in[?next]">Send me a new link</ButtonLink>
</AuthShell>
```

One message for expired and reused links (it does not say which, and creates no session: spec "Expired or reused link"). The button goes to the form because the address is not known from a spent link.

### S4. Consent (`/consent`)

```html
<AuthShell account={email, signOutAction} [stageName]>
  <h1>Let this app act for you on A2H?</h1>
  <section aria-label="The app asking to connect" class="identity">   <!-- --border, --radius-lg -->
    <p class="eyebrow">App asking to connect</p>                         <!-- --text-xs, --text-muted -->
    <h2 class="name">{client_name}</h2>                                  <!-- --accent, machine origin -->
    <p class="origin">{origin}</p>                                       <!-- mono role -->
    <p class="provenance">{provenance}</p>                               <!-- --text-muted; --text when dynamic -->
  </section>
  <section aria-labelledby="consent-scopes">
    <h2 id="consent-scopes">It will be able to</h2>
    <ul><li>{scope in plain words}</li>…</ul>
  </section>
  <Notice tone=platform title="You still approve every question">…</Notice>
  [<Notice tone=danger|neutral>]                                         <!-- error, offline -->
  <p>It will act for <strong>{address}</strong>.</p>
  <p class="muted">After you choose, you go back to {return origin}.</p>
  <form method=post action={consent}>
    <input type=hidden …consent fields…>                                 <!-- never displayed -->
    <Button primary type=submit name=accept value=true>Connect</Button>
    <Button ghost type=submit name=accept value=false>Don't connect</Button>
  </form>
  <p class="muted">You can disconnect it at any time from <TextLink href="/account/clients">Connected apps</TextLink>.</p>
</AuthShell>
```

Data (props, from the authorization server; web dev):
- `client.name`: `client_name` from the metadata document, the dynamic registration or the pre-registered record. Rendered as text only (React escapes it), wraps anywhere, never truncated (a long name must be readable in full; story "ConsentLongName").
- `client.origin`: the host the client is identified by: the `client_id` URL's host for a metadata-document client; the redirect URI's host for a dynamic or pre-registered client. `localhost`, `127.0.0.1` and `[::1]` are shown as **a program on this computer** (Claude Code and other CLI clients).
- `client.registration`: `metadata-document` | `dynamic` | `pre-registered`, which picks the provenance line:
  - metadata document: **Name published by {origin}.**
  - pre-registered: **Registered with A2H by the A2H team.**
  - dynamic: **This app registered itself. A2H has not checked its name. Continue only if you started this connection.** (in `--text`, not muted)
- `scopes`: the requested scopes, each in plain words; scope identifiers are never shown:
  - `a2h`: **Find humans, send them approved questions and read their answers on your behalf**
  - `offline_access`: **Stay connected without signing in again**
- `returnOrigin`: the redirect URI's host, same local rule.
- `email`: the signed-in principal's own address.

Copy:
- h1 **Let this app act for you on A2H?**; eyebrow **App asking to connect**; h2 **It will be able to**
- platform note **You still approve every question** / "Every question is shown to you for approval before it is sent. Nothing reaches a person without your yes." (the one rule, principal side)
- **It will act for {address}.** / **After you choose, you go back to {origin}.**
- primary **Connect** (pending **Connecting…**), ghost **Don't connect** (pending **Cancelling…**). Labels are fixed: the client's name never goes on a button (a name like "Cancel" must not be able to relabel the accept action).
- **You can disconnect it at any time from Connected apps.** (link)

States:
- **Ready**: as above.
- **Accepting / declining**: the pressed button shows its pending label; the other is disabled until the response.
- **Declined**: the authorization server redirects to the client with `access_denied`; no A2H screen. Fallback only if the redirect cannot happen: h1 **Not connected** / "{client} was not connected to your A2H account. You can close this page."
- **Error** (the consent post failed): `Notice danger` **Your choice was not recorded** / "Nothing was connected. Try again." + reference; buttons stay.
- **Offline**: `Notice neutral` **You're offline** / "Nothing is connected. Choose when you're back online." Nothing is queued: consent is never sent later on the person's behalf.
- **Invalid request** (unknown client, metadata document refused, redirect URI mismatch, private-address document; PKCE errors are refused before this screen per spec): h1 **This connection can't continue**, `Notice danger` **Nothing was connected** / "The app's request to A2H was not valid. Go back to the app and start the connection again. If it keeps happening, the app may not work with A2H yet." + reference. No client name (it could not be established), no reason code.
- **Expired** (the consent request timed out): h1 **This connection request has expired**, `Notice danger` **Nothing was connected** / "Go back to the app and start the connection again."
- **Loading / empty**: none; server-rendered after the authorization server has validated the request.

### S5. Connected apps (`/account/clients`)

```html
<AuthShell width=wide account={email, signOutAction} [stageName]>
  <h1>Connected apps</h1>
  <p class="lead">These apps can act for you on A2H. Every question they draft is still shown to you before it is sent.</p>
  [<Notice tone=success live=status focusable>]                      <!-- after a disconnect -->
  [<Notice tone=neutral|danger>]                                     <!-- offline, error -->
  <ul aria-label="Connected apps">                                   <!-- --border top and between rows -->
    <li>
      <h2 class="name">{client_name}</h2>                            <!-- --accent -->
      <p class="origin">{origin}</p>                                 <!-- mono -->
      <p class="dates">Connected {date} · last used {date}</p>       <!-- --text-muted, tabular-nums, <time> -->
      <Button ghost aria-label="Disconnect {client} ({origin})">Disconnect</Button>
      [<div role=group aria-labelledby=q tabindex=-1 class="confirm">] <!-- --surface-2, --border-strong -->
         <p id=q>Disconnect {client}?</p>
         <p>It will not be able to reconnect without asking you again. Access it already has ends within an hour. Requests you already approved are not affected.</p>
         <Button primary>Disconnect</Button> <Button ghost>Keep connected</Button>
      [</div>]
    </li>
  </ul>
</AuthShell>
```

Data per row (`ConnectedClient`): `id`, `name`, `origin`, `registration`, `connectedAt` and `lastUsedAt` as `{ iso, label }` formatted by the app (dates at the edge; `lastUsedAt: null` reads **not used yet**). One row per client holding a consent for this principal.

Copy: h1 **Connected apps**; lead as above; row dates **Connected {date} · last used {date}** / **· not used yet**; **Disconnect**; confirmation **Disconnect {client}?** / "It will not be able to reconnect without asking you again. Access it already has ends within an hour. Requests you already approved are not affected." / primary **Disconnect** (pending **Disconnecting…**) / ghost **Keep connected**.

The confirmation tells the truth of spec "Client revoked": refresh tokens die at once, access tokens already issued live to their expiry (one hour at most, D1).

States:
- **Ready**: the list, most recently used first.
- **Empty**: `Notice neutral` **No apps are connected** / "To connect one, add A2H as a connector in your agent, for example Claude or Claude Code, and sign in when it asks."
- **Loading** (client-side refresh only; the first render is server-side): three skeleton rows in a `role=status aria-busy=true` container labelled "Loading connected apps".
- **Error** (list could not be read): `Notice danger` **Connected apps could not be loaded** / "Your connections are unchanged. Reload the page to try again." + reference; ghost **Reload**.
- **Offline**: `Notice neutral` **You're offline** / "This list may be out of date. Disconnecting needs a connection." The list stays; a disconnect attempt fails into the row error.
- **Confirming → revoking → done**: inline, never a browser dialog. Done removes the row and shows `Notice success` **{client} is disconnected** / "Access it already has ends within an hour."
- **Revoke failed**: the row keeps its **Disconnect** button and shows `Notice danger` **{client} is still connected** / "The disconnection did not go through. Try again." + reference.
- **Sign out** (header): `POST`, then `/signed-out`. If it fails: `Notice danger` **You are still signed in** / "Signing out did not go through. Try again."

### S6. Signed out (`/signed-out`)

```html
<AuthShell [stageName]>
  <h1>You're signed out</h1>
  <p class="lead">Apps you connected stay connected: signing out of this page does not disconnect them. To disconnect one, sign in and open Connected apps.</p>
  <ButtonLink primary fullWidth href="/sign-in">Sign in again</ButtonLink>
</AuthShell>
```

The lead states the difference between the browser session (revoked) and the consents held by agents (kept), which spec "Sign-out revokes" separates.

### Email: magic link (`packages/email/src/magic-link.ts`)

Reviewed 2026-10-30 against the template from PR #53 (`pnpm --filter @a2h/email preview`). Approved in structure: it carries the link and its validity and nothing else (no address, no name, no client, no image, no question text), the system font stack, a plain-text version, sentence case, and the reassurance line for unrequested emails. **Four wording changes for the web dev**, so the email and the screens say the same thing (S3 tells the person to open the link in the same browser, which the consent flow needs):

| Where | Now | Change to |
|---|---|---|
| Body, first line | "Use this link to sign in. It works for 15 minutes and only once." | "Use this link to sign in. It works once and for 15 minutes. Open it in the browser where you asked for it." |
| Preview text | "Sign in to A2H. It works for 15 minutes and only once." | "Sign in to A2H. The link works once and for 15 minutes." |
| New line after the copy-the-address block | (none) | "If it has expired, ask for a new one on the sign-in page." |
| Stage label (`stageLabel`), notice line and subject prefix | "development" / "preview pr-12"; "This email comes from the preview pr-12 stage of A2H."; "[preview pr-12] Your A2H sign-in link" | "test stage dev" / "test stage pr-12"; "This email comes from A2H test stage pr-12, not the live service."; "[test stage pr-12] Your A2H sign-in link" (same words as the screens' stage line; no "development" anywhere, task 4.1) |

Final copy (prod; the stage line and prefix appear on non-production stages only, which write to the mail sink and send nothing):
- Subject **Your A2H sign-in link**
- Preview **Sign in to A2H. The link works once and for 15 minutes.**
- h1 **Sign in to A2H**
- **Use this link to sign in. It works once and for 15 minutes. Open it in the browser where you asked for it.**
- call to action **Sign in to A2H** (the link)
- **If the link does not open, copy this address into your browser:** followed by the URL as plain text, `word-break: break-all`
- **If it has expired, ask for a new one on the sign-in page.**
- **If you did not ask to sign in, ignore this email. Nobody can sign in without this link.**
- `{validity}` stays computed from `expiresInMinutes` ("1 minute" / "N minutes"); the copy above shows the 15-minute value.

**The call to action today and later.** Today it stays a plain underlined `<a>` in the mail client's default link colour: correct for now. The semantic tokens this change adds resolve to CSS system colours (`LinkText`, `Canvas`), which mail clients do not support and which cannot be inlined, so the email must not take them; the "no colour value in the email HTML" test stays. When `m2-design-foundations` lands the primitive ladder, the link becomes **one primary button** (skill §3.1, §8; pattern 4d's "one primary button"):
- React Email `Button` (table-based, works in Outlook), label unchanged **Sign in to A2H**, the whole button the link;
- background the inlined value of `--accent`, text `--on-accent`, no underline, font 16 px weight 600 on the system stack, padding 12 px 24 px, radius `--radius-md` (8 px), height at least 44 px, left-aligned with the body text;
- values inlined at build from `packages/ui` tokens as solid sRGB, light-only (skill §2.3, §8), never written by hand in `packages/email`; the test changes from "no colour" to "only colours from the inlined token map";
- the plain URL fallback stays below it, unchanged; no second button, no image, no web font.

### Accessibility (all screens)

- **Keyboard-complete.** Every action is a React Aria `Button`/`Link` or a native input; Tab order follows the DOM: header (Sign out), main heading content, field, primary action, secondary action, links. Forms submit with Enter. In a connected-apps row, **Disconnect** opens the confirmation and moves focus to it (a labelled group); **Keep connected** or **Escape** closes it and returns focus to **Disconnect**; a failure moves focus to the row's error notice; success moves focus to the "disconnected" notice. No focus trap anywhere; no browser `confirm()`.
- **Focus visible**: `outline: 2px solid var(--focus); outline-offset: 2px` on every control (`:focus-visible` and React Aria's `data-focus-visible`), never removed.
- **Targets**: 44 × 44 px minimum on buttons, button links and inputs (`--target-min`) at 390 px and 1280 px. Inline links inside a sentence are exempt (WCAG 2.5.8) and are underlined.
- **Forms**: visible `<label for>`; errors via `FieldError`, linked with `aria-describedby`, `aria-invalid="true"`, prefixed "Error:"; the field keeps its value; validation messages say what to do. `autocomplete="email"`, `inputmode="email"`, `spellcheck="false"`.
- **Announcements**: errors after an action `role=alert`; confirmations (resent, disconnected, offline) `role=status`; notices present on page load are plain content. Pending buttons keep focus and announce busy (React Aria `isPending`).
- **Headings**: one `h1` per screen; the client name is an `h2` on consent and in each row, so the list is navigable by heading.
- **Colour is never the only signal**: every notice has a title in words; the client's accent name sits under the words "App asking to connect"; links are underlined.
- **Reduced motion** is the default stylesheet; the skeleton pulse and button transition exist only under `prefers-reduced-motion: no-preference`.
- **Contrast**: system colours and `color-mix` derivations; no new pair is introduced beyond the semantic roles. Measured by axe (WCAG 2.2 AA rules) on every story in both themes during the review pass below. CI contrast tests on the ladder arrive with `m2-design-foundations`.
- **Zoom and reflow**: single column, no horizontal scroll at 320 px CSS width; long names and addresses wrap (`overflow-wrap: anywhere`).
- `<html lang="en">`; safe-area insets on the gutters.

### Never shown on these screens

- Tokens of any kind (access, refresh, magic-link, consent codes, authorization codes, `state`, PKCE values), client secrets, client ids, scope identifiers, error codes or stack traces. A request id ("Reference …", mono) is the only technical string, and only on errors.
- Any address other than the signed-in principal's own; on sign-in screens, only the address the person typed. Nothing on any screen distinguishes an allow-listed address from an unknown one.
- The client's logo, `client_uri`, `policy_uri`, `tos_uri` or any other link from its metadata (they are unverified and a phishing vector); the client's name on a button.
- The word "development"; "allow-list"; any protocol jargon (`copy.test.ts`).
- The question text of any request; participants' names or anything about participants.
- The address in a URL query string (sent page uses form state or a flash cookie).

### Prototype and PRD

The principal prototype's connector step ends in "Connect and set my contact policy"; the contact policy is M5 scope (proposal, Out of scope), so consent ends in **Connect** and the stage's default policy applies (D4). The prototype's colours and fonts are not normative (ADR 0003); nothing here takes them.

### Open questions on the screens

For the product owner:
1. The sign-in footnote "A2H is open to invited addresses only for now." is shown to everyone before submission, so it reveals nothing about a given address, but it does say a list exists. Keep it (strangers understand why no email comes) or drop it?
2. Name of the list: "Connected apps" (chosen: plain, what Google and GitHub call it) or "Connected agents"?
3. The empty state of Connected apps could link to a public setup page (`docs/runbooks/mcp-setup.md` is internal). Is there a public URL to point at, or none for M1?

PM defaults applied in group 5 until the owner says otherwise (2026-10-30): keep the footnote (it tells a stranger why no email comes and reveals nothing about any address); the page is "Connected apps"; the empty state carries no external link in M1.

For the web dev (task 5.4):
4. "Last used": if Better Auth records no last use per client, pass `lastUsedAt` as `undefined` and the row shows only "Connected {date}". `null` means "not used yet".
5. The consent page needs the client's registration kind (metadata document, dynamic, pre-registered) and the redirect URI's host, beyond `client_name`; and distinct outcomes for an expired versus an invalid consent request.
6. "Requests you already approved are not affected" (revoke confirmation) assumes revoking a client never cancels the principal's requests. Confirm with protocol-dev; if it ever does, the sentence changes.
7. Consuming `@a2h/ui` from `apps/web`: source package with CSS modules, so `transpilePackages: ["@a2h/ui"]` in `next.config.ts`; import `@a2h/ui/tokens.css` and `@a2h/ui/base.css` once in the root layout.

### Review on Storybook (2026-10-30)

Storybook build `pnpm --filter @a2h/ui build-storybook` (46 stories: 10 component states, 36 screen states). Playwright pass over every story at 390 px and 1280 px, light and dark (`prefers-color-scheme` and `data-theme`), reduced motion on: screenshots, axe-core 4.14 (WCAG 2.0/2.1/2.2 A and AA plus best practice), a 44 px target check and a horizontal-overflow check. Keyboard pass on Sign in, Check your email, Consent, Link expired, Signed out and Connected apps (Interactive story). Result: 184 runs, no axe violation, no control under 44 px, no horizontal overflow; Tab order as specified, focus visible (2 px) on every stop, disconnect focus moves (open, Escape, failure, success) as specified. Not run: a screen reader, real browsers other than Chromium, the built pages in `apps/web` (task 5.4 preview review). The preview review of the built pages (task 5.4) follows the same checklist once `apps/web` serves them.

## Risks / Trade-offs

- [claude.ai does not render the approval form] → the spike runs first; proposal decision 6 lists the fallbacks; the authorization build is unaffected by the outcome.
- [Data API latency on sign-in] → only sign-in, consent and token paths touch the database from the web app; measured in task 3 and recorded; the NAT alternative stays available as an infra-only change (ADR 0001 decision 2 pattern).
- [JWKS fetch failure] → tokens are verified against the cached keys for up to 10 minutes; a cold instance that cannot reach the JWKS URL answers 401, never 200; alarm on the metric.
- [Preview tokens on dev] → audience and issuer are per stage; the contract test "Preview tokens stay on the preview" pins it.
- [WAF hits shared egress] → the edge limit is coarse and per address on the MCP and auth paths only; the per-principal limit is the one meant to bite; Anthropic's /21 would need more than the edge limit across all its users of this stage to trigger.
- [DCR abuse] → registrations are pruned; rate-limited at the edge; no secret issued to dynamic clients.
- [Hosted zone delegation delay] → the owner's domain step is the first task and gates the rest; certificates are DNS-validated inside the zone.

## Migration Plan

1. Owner: register or delegate the domain into a Route 53 hosted zone in the A2H account (runbook §8); request SES production access on the domain (§9).
2. PR: `domain` set, SES identity, Data API on prod cluster, WAF; dev deploy issues the certificates and records; preview URLs change to the domain. The contract tests take the URLs from the deploy outputs as today.
3. Spike on dev (task 1); decision 6.
4. PRs for the authorization server, the resource server and principals, limits, mail sink, tests, documentation, each into the change branch.
5. Cut-over: when the resource-server PR deploys to a stage, unauthenticated calls start failing; CI's verify job signs in through the sink before its contract run; the owner re-adds the connector with "Sign in now".
Rollback: unset `domain` (returns to HTTP on the load-balancer hostname) or disable the gate per stage with `AUTH_REQUIRED=false` on dev and previews only; prod never ships with it false.

## Open Questions

- claude.ai's own hosted CIMD document URL is not published; if claude.ai falls back to DCR, nothing changes in this design.
- Whether Better Auth 1.7 emits the RFC 9207 `iss` parameter (checked in task 3).
- The exact WAF path condition for preview MCP paths (`/pr-*/mcp`) versus dev's `/mcp`: one rule with a regex on both, decided in task 2 with a test.
