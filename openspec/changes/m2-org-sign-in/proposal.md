# Proposal: m2-org-sign-in

First change of M2 "First free release" (PRD v0.3 §13, approved 2026-11-11). M2 is split into three changes, one at a time: **m2-org-sign-in** (this one), **m2-first-answer** (a request to a named person, minimal rules, email, request page, signed answer, switching a person off), **m2-install-package** (licence, containers, provider interfaces, install guide, release).

## Why

A2H is now installed by an organisation for its own people (ADR 0006). Today the only way in is a magic link to an address on an allow-list the owner edits by hand, and there is no administrator. An organisation cannot install that: its people must come in through the identity provider it already runs, and someone in the organisation must be able to manage who has access. Everything else in M2 depends on people existing as accounts.

## What Changes

- **Sign-in through the organisation's identity provider.** An install is configured with one identity provider (standard OpenID Connect: issuer, client id, client secret). The sign-in page sends the person there; whoever that provider authenticates for this application, with a verified email address, is signed in. The organisation decides who that is in its own provider. No passwords and no user list are kept by A2H.
- **A person exists from their first sign-in.** One account per person, used both to ask (as a principal) and, from the next change, to be asked. A principal who signed in this way is recorded as verified by the method `organisation_idp`.
- **BREAKING for installs, not for our stages: magic links become a development tool.** Magic-link sign-in with the allow-list stays available on our development stages (dev, previews), next to the identity provider when one is configured, so that CI keeps working. A production install never offers it.
- **Access follows the identity provider.** A web session lasts at most 12 hours, then the person signs in at the provider again. An agent's connection can renew itself only while its principal has signed in at the provider within the last 7 days. Without directory synchronisation (paid edition) this is how a leaver's access ends; an administrator can end it at once.
- **Administrators.** The install's configuration names the first administrators by email address. An administrator sees the list of people (name, email address, whether they have access, whether they are an administrator), can remove a person's access and restore it, and can make another person an administrator or withdraw that. The last administrator cannot be withdrawn. Administrators cannot see requests, answers or anyone's rules. Every administrator action is recorded and visible to all administrators.
- **A2H stays the authorization server for agents.** The connector flow (consent, tokens, revocation) is unchanged; the identity provider only replaces how the person proves who they are. ADR 0004 excluded an external identity provider for M1; a new ADR 0008 records the change.

### Out of scope

- Switching a person off as a participant, profiles, rules, discovery of real people, delivery and answering: **m2-first-answer** and M3.
- Teams and roles from the provider's groups: M3. This change only checks and documents how Google Workspace, Okta and Microsoft Entra ID expose groups.
- SAML, directory synchronisation (SCIM), several identity providers per install: paid edition.
- Removing the money fields, Stripe code or simulated participants.
- The size limit of the free edition (M3).

## Capabilities

### New Capabilities
- `platform/administration`: who is an administrator, what they can and cannot do to people's access, and the record of their actions.

### Modified Capabilities
- `platform/principal-identity`: sign-in through the organisation's identity provider; magic links limited to development stages; the verification method `organisation_idp`; how long access lasts without a new sign-in at the provider.

## Impact

- `apps/web`: sign-in page and callback for the identity provider; session lifetime; the administrators' page. Configuration gains the provider settings and the first administrators.
- `packages/db`: accounts gain the provider's subject identifier, the time of the last sign-in at the provider, an access state and an administrator flag; a table of administrator actions; the principal verification method gains `organisation_idp` (migration of the check constraint).
- `apps/mcp`: none expected; token renewal is refused by the web app.
- `infra/`: the provider's client secret as a stage secret; configuration per stage. No change to production resources of an install (that is m2-install-package).
- `tests/`: sign-in, callback and renewal scenarios against a Keycloak container in CI; the administrators' page end to end; existing magic-link tests keep running on development stages.
- `docs/decisions/0008`: external identity provider for sign-in (amends ADR 0004). `docs/runbooks/`: how to register A2H in Google Workspace, Okta and Microsoft Entra ID.
- `packages/ui`: people list and confirmation patterns for the administrators' page (Design).

## Risks

- **A provider that does not assert a verified email address.** Sign-in is refused; the runbook says how to configure each provider. Microsoft Entra ID's email claim needs care; to be verified with its documentation before design.
- **Leavers keep access for up to 12 hours on the web and up to 7 days through an agent** unless an administrator removes them. Shorter windows mean people re-approve their agents more often.
- **Validation against real providers needs tenants we do not have.** CI covers Keycloak only. Google Workspace is validated at Gate 2 if the owner registers the application there; Okta and Microsoft Entra ID are checked on free developer tenants only if the owner creates them, and are otherwise reported as not validated.
- **Two sign-in methods on development stages** double the paths to test; the production configuration must make the magic-link path unreachable, and a test proves it.

## Owner decisions at Gate 1 (2026-11-11)

1. Gate 2 is validated with the owner's Google Workspace on the dev stage; the owner registers the application and stores its secret.
2. The renewal window for agents is 7 days since the principal's last sign-in at the provider.
3. Removing access ends sessions and agent connections at once and keeps the record. Marking someone as having left comes with answer reuse (M4).

## Clarifications after the technical findings (2026-11-11, PM calls; `notes/technical-findings.md`)

None changes an owner decision; each is reflected in the spec deltas.

- Microsoft Entra ID has no "email verified" claim, so which claim carries the assertion is a setting of the install.
- After the 7-day window, an agent that kept its connection resumes once its principal has signed in again; one that discarded it reconnects without a consent screen.
- At 12 hours the person is sent back to the provider; if the provider still has a session for them they come back signed in without typing anything. This is ordinary single sign-on and still ends access for someone the provider no longer accepts.
- On a production install a person is never matched to an existing account by email address alone, and an address already used by another account is refused.
- An administrator's access can be removed by another administrator, including one named in the configuration; the last administrator with access cannot be removed.
- On development stages the allow-list applies only to magic-link sign-ins and the 7-day window only to provider sign-ins.

## How the product owner validates (Gate 2)

1. On the dev stage, open the sign-in page and choose your organisation's sign-in. You land signed in without typing a password into A2H.
2. Connect an agent as today (consent page); send a simulated request; the principal is shown as verified by your organisation.
3. Open the administrators' page: you are listed as administrator. Sign in with a second account, see it appear, remove its access, and see that account signed out and its agent refused.
4. Try to withdraw yourself as the only administrator: refused.
5. Check the record of administrator actions.
