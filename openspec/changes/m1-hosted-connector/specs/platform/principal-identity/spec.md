# Spec Delta

## Purpose

A principal is a signed-in account that owns requests and authorizes the agents acting for it: sign-in by magic link, consent to a client, and the OAuth 2.1 authorization server of the stage that issues and refreshes the tokens those clients present to the connector.

## ADDED Requirements

### Requirement: Sign-in by magic link to an allow-listed address
A stage SHALL let a person sign in by entering an email address and following a single-use link sent to it; only addresses on the stage's allow-list SHALL receive a link, and any other address SHALL get the same neutral confirmation without a link being created.

#### Scenario: Allow-listed address
- **WHEN** an allow-listed address is entered
- **THEN** one magic link valid for at most 15 minutes is sent to that address, and following it once signs the person in and makes the link unusable

#### Scenario: Unknown address
- **WHEN** an address that is not on the allow-list is entered
- **THEN** the page shows the same confirmation as for a known address, no link is created, and nothing about the address is logged

#### Scenario: Expired or reused link
- **WHEN** a magic link is followed after it expired or a second time
- **THEN** sign-in is refused with an offer to request a new link, and no session is created

### Requirement: Magic links leave production only through email
On the production stage a magic link SHALL be delivered by email only; on every other stage it SHALL be written to the stage's private mail sink and never sent to a real mailbox, so that previews and the development stage never depend on email delivery.

#### Scenario: Preview sign-in
- **WHEN** an allow-listed address signs in on a preview or development stage
- **THEN** the link appears in that stage's mail sink, readable only with the stage's deploy credentials, and no email leaves the platform

### Requirement: Consent names the client and the scopes
Before a token is issued to a client, the signed-in principal SHALL see a consent screen naming the client (from its metadata document, its registration or its pre-registered record) and listing the requested scopes in plain words; a token SHALL be issued only on accept.

#### Scenario: Consent accepted
- **WHEN** the principal accepts the consent for a client requesting the `a2h` scope
- **THEN** the client receives an authorization code bound to its PKCE challenge, its redirect URI and the requested resource, and the consent is recorded for that client and principal

#### Scenario: Consent declined
- **WHEN** the principal declines
- **THEN** the client receives `access_denied` and no code or token exists for it

### Requirement: Clients register by metadata document, dynamic registration or pre-registration
The stage's authorization server SHALL accept a client identified by an HTTPS Client ID Metadata Document, a client created by dynamic registration, and a client pre-registered in the stage's configuration; its metadata SHALL advertise metadata-document support, `none` among the token endpoint authentication methods, S256 as the only code challenge method, and the issuer identifier parameter.

#### Scenario: Metadata-document client
- **WHEN** a client presents a `client_id` that is an HTTPS URL whose document names that same `client_id`, a `client_name` and `redirect_uris` that include the redirect used
- **THEN** the authorization proceeds with that client name on the consent screen and the document is cached; a document whose `client_id` differs or whose redirect URIs do not include the one used is refused

#### Scenario: Metadata document from a private address
- **WHEN** a `client_id` URL resolves to a loopback, link-local or private network address
- **THEN** the document is not fetched and the client is refused

#### Scenario: Dynamic registration
- **WHEN** a client registers dynamically with `redirect_uris` and an `application_type`
- **THEN** it receives a `client_id`, and the registration is marked as dynamic so it can be pruned

#### Scenario: PKCE missing
- **WHEN** an authorization request arrives without a code challenge, or with a method other than S256
- **THEN** it is refused with `invalid_request` before any consent screen is shown

### Requirement: Tokens are short-lived, audience-bound and refreshable
Access tokens SHALL be signed, SHALL carry the principal, the client, the scopes, the issuer and the audience named by the `resource` parameter, and SHALL expire within one hour; refresh tokens SHALL rotate on every use, and a replayed refresh token SHALL revoke its family.

#### Scenario: Resource recorded as audience
- **WHEN** a token request names the stage's MCP URL as `resource`
- **THEN** the access token's audience is exactly that URL and its lifetime is one hour or less

#### Scenario: Refresh token replayed
- **WHEN** a refresh token that was already exchanged is presented again
- **THEN** the request is refused and every token descended from that family is revoked

### Requirement: Sign-out revokes
A signed-in principal SHALL be able to see the clients that hold consent and to revoke any of them, and signing out SHALL revoke the session.

#### Scenario: Client revoked
- **WHEN** the principal revokes a client's consent
- **THEN** that client's refresh tokens are invalid from then on and its next refresh fails, while access tokens already issued expire at their own expiry
