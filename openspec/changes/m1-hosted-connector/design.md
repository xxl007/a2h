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

### D5. Limits
- Edge: an AWS WAF web ACL with a rate-based rule on the MCP and `/api/auth` paths, associated with the ALB (regional scope, eu-west-3) and with the web CloudFront distribution (CloudFront scope, which AWS requires in us-east-1: the second exception to ADR 0001's one-region rule, like ACM for CloudFront, holding no data). The limit per stage comes from `infra/config.ts` (default 600 requests per 5 minutes per address). Health is excluded. Previews share dev's ALB and its web ACL.
- Per principal: a `rate_limit_windows` table (`principal_id`, `window` = minute or day start, `count`), one upsert per tool call before validation (`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`), compared with the stage's limits (defaults 60 per minute, 2,000 per day). Over the limit: a `ProtocolError` `rate_limited` with `retry_after_seconds`, nothing else written. Windows older than a day are deleted by the worker's expiry job. Shared across instances because it is in Postgres; one statement per call.
- Held pings: an in-process counter capped by `PING_MAX_CONCURRENT` (default 4) per instance; the cap is per instance by design, since a held connection is a resource of the instance holding it.
Alternative rejected: in-memory per-instance limits for principals (not shared across instances, spec "Limit shared across instances").

### D6. Magic links on non-production stages go to a mail sink
`packages/email` gets its first template (magic link; React Email) and a `Mailer` interface with two implementations: SES (prod) and an S3 sink that writes `{to, subject, text, html, sent_at}` under `<stage storage prefix>/mail/<ulid>.json` in the existing bucket, readable only through the deploy role (QA's Playwright helper and the owner through a documented CLI line). Nothing on a non-prod stage can send email, by construction. The allow-list means a sink object never contains an unknown person's address.

### D7. Allow-list and other owner-settable values
Allow-listed addresses live in an SSM SecureString parameter per environment (`/a2h/shared/principal-allowlist` for dev and previews, `/a2h/prod/principal-allowlist` for prod), created empty by the deploy and set by the owner with one CLI line (runbook). The web app reads it at cold start and refreshes it every five minutes. The domain stays in `infra/config.ts`; the limits and `PING_OPEN` are stage configuration next to the development policy.

### D8. Clients
CIMD and DCR both enabled (spec "Clients register…"); the authorization-server metadata advertises `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported` including `none`, `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported: true` (verified against Better Auth during task 3; if Better Auth does not emit `iss`, the gap is recorded and the claim removed). Dynamic registrations older than 30 days without a token are pruned by the worker. Pre-registered clients (id, redirect URIs, optional secret hash) come from stage configuration for hosts that cannot use CIMD or DCR.

### D9. Order of work: domain, TLS, spike, then authorization
Nothing hosted can be tried before TLS, and the claude.ai approval-form question decides the shape of Gate 2, so the order is: hosted zone and `domain` (owner, then one infra PR); claude.ai connector spike on dev with "No sign-in", driving `request_human` to the approval; decision 6 of the proposal; then the authorization build, which does not depend on the spike's answer.

### D10. Logging and records
Tokens, magic links, emails and client secrets never appear in logs or rows (spec "Tokens are never forwarded"). Log lines carry the opaque principal id, the client id and the request id. Better Auth's own logger is set to the structured logger with its default `info` lines on auth events only.

## Screens (Design agent, after Gate 1)

Sign-in (email field, allow-list neutral confirmation), "Check your email", consent (client name and origin, scopes in plain words, accept and decline), connected clients with revoke, signed-out. Each with empty, loading, error and offline states; tokens from `packages/ui`; copy in `design.md` of this change under this section.

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
