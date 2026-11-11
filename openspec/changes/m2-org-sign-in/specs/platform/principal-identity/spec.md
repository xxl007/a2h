# Spec Delta

## ADDED Requirements

### Requirement: Sign-in through the organisation's identity provider
An install SHALL let a person sign in through the one OpenID Connect identity provider named in its configuration. A person the provider authenticates for this application, with an email address the provider asserts as verified, SHALL be signed in; A2H SHALL NOT keep a password or a list of permitted people for this method.

#### Scenario: First sign-in creates the account
- **WHEN** a person who has never signed in completes sign-in at the configured provider
- **THEN** an account is created for them with the provider's subject identifier, name and email address, and they are signed in

#### Scenario: Returning person is recognised by the provider's identifier
- **WHEN** a person signs in again after their email address changed at the provider
- **THEN** they reach the same account, recognised by the provider's subject identifier, and the stored email address is updated

#### Scenario: Email address not verified
- **WHEN** the provider's answer carries no email address or does not assert it as verified
- **THEN** sign-in is refused with a page telling the person to contact their administrator, no account or session is created, and the address is not logged

#### Scenario: Answer not meant for this install
- **WHEN** the callback carries an answer from another issuer, for another client, with a wrong state or nonce, or one already used
- **THEN** sign-in is refused and no session is created

#### Scenario: Person cancels or the provider refuses
- **WHEN** the provider returns an error or the person cancels
- **THEN** the sign-in page is shown again with a neutral message and no session is created

### Requirement: Principals signed in through the identity provider are verified by it
A principal created at consent by a person who signed in through the identity provider SHALL be recorded as verified with the verification method `organisation_idp`. A second consent SHALL never change a stored principal's verification.

#### Scenario: Consent creates a principal verified by the organisation
- **WHEN** a person signed in through the identity provider accepts consent for the first time
- **THEN** the principal is created with `verified` true and verification method `organisation_idp`, in the transaction that records the consent

#### Scenario: Principal can send
- **WHEN** that principal's client calls `request_human` with a manifest that passes every other check
- **THEN** validation does not refuse it at the principal stage and the approval follows

### Requirement: Access lasts only while the identity provider vouches
A web session SHALL end at most 12 hours after the sign-in at the provider that created it. A client's refresh SHALL be refused when its principal's last sign-in at the provider is more than 7 days old; signing in again SHALL restore it without a new consent.

#### Scenario: Session reaches twelve hours
- **WHEN** a signed-in person uses the web app more than 12 hours after signing in at the provider
- **THEN** they are sent to sign in at the provider again

#### Scenario: Agent renews within the window
- **WHEN** a client refreshes its token and its principal signed in at the provider within the last 7 days
- **THEN** the refresh succeeds as today

#### Scenario: Agent renews after the window
- **WHEN** a client refreshes its token and its principal's last sign-in at the provider is more than 7 days old
- **THEN** the refresh is refused with an error that tells the client its principal must sign in again, and the access token already issued expires at its own expiry

#### Scenario: Principal signs in again
- **WHEN** that principal signs in at the provider again
- **THEN** the client can obtain tokens again without a new consent

### Requirement: Magic-link sign-in exists on development stages only
Magic-link sign-in SHALL be available only on development and preview stages, where the link is written to the stage's private mail sink and never sent to a real mailbox. A production install SHALL NOT offer magic-link sign-in, create magic links or read an allow-list.

#### Scenario: Preview sign-in
- **WHEN** an allow-listed address signs in on a preview or development stage
- **THEN** the link appears in that stage's mail sink, readable only with the stage's deploy credentials, and no email leaves the platform

#### Scenario: Production install
- **WHEN** a magic link is requested on a production install by any route
- **THEN** the request is refused, no link is created and the sign-in page offers the identity provider only

#### Scenario: Both methods on a development stage
- **WHEN** a development stage is configured with an identity provider
- **THEN** its sign-in page offers both the identity provider and the magic link

## MODIFIED Requirements

### Requirement: Sign-in by magic link to an allow-listed address
Where magic-link sign-in is available (development and preview stages only), a stage SHALL let a person sign in by entering an email address and following a single-use link sent to it; only addresses on the stage's allow-list SHALL receive a link, and any other address SHALL get the same neutral confirmation without a link being created.

#### Scenario: Allow-listed address
- **WHEN** an allow-listed address is entered
- **THEN** one magic link valid for at most 15 minutes is sent to that address, and following it once signs the person in and makes the link unusable

#### Scenario: Unknown address
- **WHEN** an address that is not on the allow-list is entered
- **THEN** the page shows the same confirmation as for a known address, no link is created, and nothing about the address is logged

#### Scenario: Expired or reused link
- **WHEN** a magic link is followed after it expired or a second time
- **THEN** sign-in is refused with an offer to request a new link, and no session is created

### Requirement: Allow-listed principals are verified by the owner's allow-list
A principal created at consent by a person who signed in by magic link SHALL be recorded as verified with the verification method `owner_allowlist`, stored with the principal so a later identity check can find it. A second consent SHALL never change a stored principal's verification.

#### Scenario: Consent creates a verified principal
- **WHEN** an allow-listed address signs in and accepts consent for the first time
- **THEN** the principal row is created with `verified` true and verification method `owner_allowlist`, in the transaction that records the consent

#### Scenario: Signed-in principal can send
- **WHEN** that principal's client calls `request_human` with a manifest that passes every other check
- **THEN** validation does not refuse it at the principal stage and the approval follows

#### Scenario: Second consent leaves verification as stored
- **WHEN** a principal whose row already exists accepts consent for another client
- **THEN** its `verified` flag and verification method are unchanged

#### Scenario: Address removed from the allow-list
- **WHEN** the owner removes a principal's address from the stage's allow-list
- **THEN** within the allow-list refresh interval (five minutes) that principal can no longer sign in, use an existing session, consent to a client or refresh a token, and access tokens already issued expire at their own expiry (one hour at most)

## REMOVED Requirements

### Requirement: Magic links leave production only through email
**Reason**: A production install no longer has magic links; people sign in through the organisation's identity provider.
**Migration**: The mail-sink behaviour of development stages moves to "Magic-link sign-in exists on development stages only".
