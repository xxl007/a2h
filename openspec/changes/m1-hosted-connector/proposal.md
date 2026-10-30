# Proposal: m1-hosted-connector

Milestone M1 (PRD §10), second and last change. The first, `m1-protocol-connector` (archived 2026-10-29), delivered the protocol, the three tools and the simulated participants on plain HTTP, validated in Claude Code. This change makes the connector reachable from hosted clients. Tracking: GitHub milestone "M1 Protocol and connector", labels `change:m1-hosted-connector`, `milestone:M1`.

## Why

The connector works, but only for someone who can launch Claude Code with two environment variables against a plain-HTTP load-balancer hostname, as the one development principal of the stage. Hosted clients (claude.ai, ChatGPT) refuse HTTP, and every request still carries the stage's development principal rather than the person who approved it. M1's gate (PRD §10) is "verified in Claude Code and one web host". That needs a domain with TLS, a real principal behind every connection (the one rule: nothing leaves a principal that the principal did not approve, so the platform must know who the principal is), authorization per the MCP specification, and limits on every public endpoint before any address is shared outside the team.

## What Changes

- **A domain and TLS for every stage.** The owner chooses the domain (decision 1); `infra/config.ts` gets it; SST then issues the certificates, creates the DNS records and switches the load balancer to HTTPS with HTTP redirected. Hostnames follow `infra/README.md`: dev web `dev.a2h-protocol.org`, dev MCP `mcp.dev.<domain>/mcp`, previews `pr-<n>.dev.<domain>` and `mcp.dev.<domain>/pr-<n>/mcp`. Prod hostnames are derived but prod is not deployed in this change.
- **Principals sign in and authorize their agents.** `apps/web` runs the OAuth 2.1 authorization server (Better Auth, decision 2) at `<web host>/api/auth`: sign-in by magic link to an allow-listed email (decision 4), a consent screen that names the client and the scopes, Client ID Metadata Documents and dynamic client registration for MCP clients, pre-registered clients where a host needs one, PKCE required, short-lived signed access tokens with rotated refresh tokens, sign-out that revokes. The web app's Lambda reaches Aurora through the Data API (decision 2), which also settles how prod migrations will run (design D2 of the previous change).
- **The MCP server becomes an OAuth resource server.** An unauthenticated call to the MCP endpoint gets `401` with `WWW-Authenticate: Bearer resource_metadata=…`; the protected-resource metadata is served per stage at the path-aware well-known URL and points at the stage's authorization server; access tokens are verified locally against the authorization server's published keys (issuer, audience = the stage's MCP URL, expiry, scope); nothing is ever served on a token meant for another resource. The principal of every tool call, every approval state and every request is the signed-in account, not the stage; the development principal disappears from the service environment. `ping`, the health path and the metadata stay unauthenticated.
- **Limits on every public endpoint.** Per-source-address rate limits at the edge (AWS WAF on the load balancer and on CloudFront), a per-principal limit on tool calls per minute and per day in the service with `429` and `Retry-After`, and a cap on concurrently held `ping` connections per instance. Limits are configuration per stage, never constants in code.
- **Verification in a hosted web client.** A spike (task 1) connects claude.ai's custom connector to dev over HTTPS without sign-in and checks whether the hosted client renders the 2026-07-28 approval form. The result decides the approval path for hosted clients (decision 6). Gate 2 is run from claude.ai and from Claude Code with OAuth.
- **Tests.** Contract tests against the preview for every scenario (401 and metadata, token audience, issuer and expiry, HTTP to HTTPS redirect, certificate, 429 and `Retry-After`, the held-`ping` cap, sign-in and consent through Playwright using the stage's mail sink), the adversarial cases of the protocol skill that concern authorization (token for another resource, forged or expired token, token passthrough, a second principal reading another's requests), and a scenario table extension in `tests/README.md`.
- **Documentation.** ADR 0004 (principal identity and connector authorization: library, token format, where the authorization server lives, Data API for the web app); runbook §8 (domain) and §9 (SES identity on the domain, production access request) completed; `docs/runbooks/mcp-setup.md` gets the claude.ai and Claude Code connection steps with OAuth.

## Out of scope

- Prod deployment and the apex hostnames; the first prod deploy is its own change once SES production access and the prod migration path are in place (M2 at the latest).
- Open sign-up for principals, the contact policy screen (identity shown to humans, budget, autonomy), wallet and billing: M5 principal surface and M4 money. In this change a principal gets the stage's default policy.
- Participant accounts and surfaces (M2, M3). Simulated participants stay as they are.
- Enterprise-managed authorization (identity-assertion grants), DPoP-bound tokens, client-credentials grants: not required by any hosted client today.
- The connector directory listings (Anthropic directory, ChatGPT app directory): private custom connectors only.
- ChatGPT verification beyond a connection smoke test: its approval-form support is undocumented; recorded as a follow-up.

## Capabilities

### New Capabilities
- `platform/principal-identity`: a principal account, sign-in by magic link, consent, and the OAuth 2.1 authorization server that issues and refreshes tokens for MCP clients (CIMD, dynamic registration, pre-registered clients), per stage.
- `platform/connector-authorization`: the MCP endpoint as an OAuth 2.1 resource server: challenge, protected-resource metadata, token verification, the principal derived from the token, scopes, and the errors.
- `platform/hosted-endpoint`: the public surface of a stage: domain and hostnames, TLS and redirect, edge rate limits, per-principal limits, the held-`ping` cap.

### Modified Capabilities
- `platform/mcp-transport`: "MCP endpoint answers over Streamable HTTP" gains the authenticated form (a call without a valid token is refused before any MCP handling; `ping` and health stay open); "Long-lived streams are not cut by infrastructure" gains the cap on concurrent held pings.
- `protocol/request-approval`: "Every request carries its principal" changes from the stage's development principal to the signed-in account of the connection; the approval state is bound to that account.
- `platform/preview-environments`: a preview has its own hostnames under the domain and its own authorization server; teardown removes its DNS records and certificates' usage.

## Impact

- `infra/`: `domain` set; WAF web ACLs for the ALB and CloudFront; the web Lambda gets Data API access to the stage's schema (IAM, no password in its environment); prod cluster gets the Data API enabled (no prod deploy); SES identity for the domain; `PRINCIPAL_*` leave the mcp service environment, replaced by the authorization server's issuer, JWKS URL and the stage's resource URL.
- `apps/web`: Better Auth with the `mcp`, `jwt`, `cimd` and `magic-link` plugins, Drizzle on the Data API, sign-in, consent and sign-out pages (design.md screens, `packages/ui`), the mail sink on non-prod stages.
- `apps/mcp`: bearer gate from `@modelcontextprotocol/server` (`requireBearerAuth`, `oauthMetadataResponse`), a JWT verifier, principal lookup, rate limiter, ping cap.
- `packages/db`: `principals` (account id, identity mode, verified flag, default policy reference), Better Auth tables (users, sessions, verification, OAuth clients, tokens, consents, JWKS), rate-limit counters.
- `packages/protocol`: the `Principal` shape is unchanged; a `scopes` list and the error codes for `unauthorized`, `rate_limited` are added.
- `packages/email`: first template (magic link), rendered with React Email, sent through SES on prod and written to the stage's mail sink elsewhere.
- `.github/workflows`: deploy and preview verify jobs sign in through the mail sink and run the new contract tests; teardown unchanged in shape.
- Dependencies: `better-auth` and `@better-auth/mcp`, `@better-auth/cimd` (1.7.x), `jose`, `drizzle-orm` Data API driver, `@aws-sdk/client-rds-data` (inside `apps/web/infra` only).

## Risks

- **Hosted clients and the approval form.** No public statement confirms that claude.ai's connector renders the 2026-07-28 `input_required` form (bug reports show it opening with `server/discover` and `Mcp-Protocol-Version: 2026-07-28`, third parties say elicitation is unsupported). The spike settles this before any build on it; decision 6 lists the fallbacks. ChatGPT's support is equally undocumented and is out of scope beyond a connection test.
- **Client registration churn.** Dynamic client registration is deprecated in the 2026-07-28 revision in favour of Client ID Metadata Documents, and claude.ai uses CIMD only when the authorization server advertises it with `token_endpoint_auth_method` `none`; both stay enabled so every client in the matrix (claude.ai, Claude Code, ChatGPT, Cursor, VS Code, Inspector) can register.
- **Email delivery.** Magic links need SES production access on the new domain, which AWS reviews over about a day. Previews and dev write magic links to a stage-private mail sink instead of sending, so nothing in this change waits for the review; prod does.
- **Two deployments to reconcile.** The web app (Lambda) and the MCP server (ECS) now share a trust relationship (issuer, keys, audience). The contract tests pin it per stage; a key rotation in the web app is picked up by the MCP server through the JWKS URL with caching bounded to minutes.
- **Edge limits and legitimate bursts.** WAF per-address limits can hit shared egress (Anthropic publishes one /21 for all hosted Claude traffic). The edge limit is set per stage well above the per-principal limit and the WAF rule counts only the MCP and auth paths; the per-principal limit is the one that bites.
- **Database access from the web app.** The Data API avoids a NAT gateway and keeps the password out of the Lambda, but it has its own quotas and latency; sign-in and consent are the only web paths touching the database in this change.

## How the product owner validates (Gate 2)

From claude.ai, Pro or Team plan, in a browser:

1. **Add the connector.** Settings → Connectors → Add custom connector, URL `https://mcp.dev.a2h-protocol.org/mcp`, authentication "Sign in now". A sign-in page on `dev.a2h-protocol.org` asks for your email; the magic link arrives (on dev it is sent through SES once production access is granted; before that, the PR gives you the dev mail sink to read it from). After sign-in, a consent screen names the client and the scopes; accept. The connector shows as connected.
2. **Run the M1 loop** (the five steps of the previous Gate 2): find a human, send a question with the approval form, decline one, check an answer, see two refusals. Each request now shows your account as principal in `check_requests`.
3. **Try without sign-in.** Open `https://mcp.dev.a2h-protocol.org/mcp` in MCP Inspector without a token: a `401` and a link to the metadata document, nothing else.
4. **Second account.** Sign in with a second allow-listed email in another client (Claude Code with `claude mcp add --transport http a2h https://mcp.dev.<domain>/mcp`, then `/mcp` to authenticate): `check_requests` lists only that account's requests.
5. **Limits.** Ask the agent to call `ping` thirty times in a row: after the configured per-minute limit the calls fail with a message that says when to retry. `http://mcp.dev.a2h-protocol.org/mcp` redirects to HTTPS.

What stays with QA: certificate and header checks, the held-`ping` cap under load, the adversarial token cases.

## Decisions needed at Gate 1

1. **Domain name.** Required before any task can run; runbook §8. **Decided 2026-10-30: `a2h-protocol.org`**, registered in Route 53 in the A2H account with its hosted zone (registration email from Route 53 forwarded by the owner). One domain serves web, MCP and email: dev web `dev.a2h-protocol.org`, dev MCP `mcp.dev.a2h-protocol.org/mcp`, previews `pr-<n>.dev.a2h-protocol.org` and `mcp.dev.a2h-protocol.org/pr-<n>/mcp`; prod `a2h-protocol.org` and `mcp.a2h-protocol.org` when prod deploys.
2. **Where the authorization server lives.** Recommended: Better Auth in `apps/web` (the product's chosen auth library; same sign-in later serves participants), with the web Lambda reaching Aurora through the Data API (no NAT gateway, no password in the Lambda, IAM-scoped per stage; resolves ADR 0001 amendment 3 and the open prod-migration question the same way). Alternatives: a NAT instance with the Lambda in the VPC; or an external identity provider (WorkOS, Auth0) with EU residency caveats and a vendor to pay.
3. **Sign-in method for principals.** Recommended: magic link by email, the same as participants will use (CLAUDE.md), with SES production access requested at the start of the change. Alternative: passkeys only, which needs no email but complicates sign-in from a second device.
4. **Who may sign in during M1.** Recommended: an allow-list of emails per stage in configuration (you and the team), everything else refused with a neutral message. Open sign-up comes with the principal surface (M5).
5. **Rate-limit defaults** (all configuration per stage): per principal 60 tool calls a minute and 2,000 a day; edge 600 requests per 5 minutes per source address on the MCP and auth paths; 4 concurrently held pings per instance. Confirm or change.
6. **Approval path for hosted clients if the spike fails** (claude.ai does not render the form): (a) URL-mode elicitation to an approval page on `dev.a2h-protocol.org` if the client supports URL mode; (b) `request_human` returns `awaiting_approval` with a link to that page and the request is created only when the page's accept arrives, a lifecycle change that would need its own spec delta; (c) ship Claude Code OAuth as the hosted verification and defer claude.ai to M5. Decide after the spike, as in M1.
