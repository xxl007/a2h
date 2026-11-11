# ADR 0008: Sign-in through the organisation's identity provider

- Status: proposed (owner approved the proposal at Gate 1 of `m2-org-sign-in`, 2026-11-11; takes effect at its Gate 2)
- Date: 2026-11-11
- Deciders: product owner (Galem L.), PM agent, Web-dev agent (findings)
- Scope: how a person proves who they are to an A2H install, and who manages access. Amends ADR 0004, decision 3 ("magic link to an allow-listed address, nothing else") and its rejection of an external identity provider. Everything else in ADR 0004 stands.
- Related: `openspec/changes/m2-org-sign-in/` (proposal, design D1–D9, `notes/technical-findings.md`); ADR 0006 (A2H for organisations); PRD v0.3 §7.1, §12.

## Context

ADR 0004 chose magic links to an allow-list kept by the owner and rejected an external identity provider, for a single hosted platform. ADR 0006 makes A2H software an organisation installs for its own people. An organisation will not keep a second user list, and its leavers must lose access when its own directory says so.

## Decision

1. **A production install has one sign-in method: the organisation's OpenID Connect provider.** A2H keeps no passwords and no list of permitted people. Standard OIDC, no vendor-specific code; validated against Keycloak in CI and Google Workspace at Gate 2. Okta and Microsoft Entra ID are documented and reported as not validated until tried.
2. **A2H remains the authorization server for agents.** The provider only replaces how the person signs in. Consent, tokens, audience, rotation and revocation are unchanged.
3. **People are matched by the provider's subject, never by email address alone, on a production install.**
4. **Access follows the provider without directory synchronisation:** sessions of 12 hours; an agent's refresh refused when its principal's last provider sign-in is older than 7 days (owner, Gate 1).
5. **Administrators** are named first in the install's configuration and can remove and restore access and name other administrators. They cannot read requests, answers or rules. Their actions are recorded in an append-only table.
6. **Magic links and the allow-list are development tools** for our dev and preview stages. A production install does not register that code path.
7. **Nothing from the provider is stored except identity** (subject, name, email address). Its tokens are discarded.

## Alternatives rejected

- **Keep magic links for installs:** a second user list for every organisation, and no link to its leaver process.
- **SAML first:** what larger enterprises ask for, but OIDC covers the three providers named in PRD §12 and is simpler to test. SAML and SCIM are paid-edition candidates.
- **Better Auth's `sso` and `admin` plugins:** built for many providers per tenant, and for impersonation and passwords; neither fits one provider per install with a restricted administrator.
- **Let the provider be the authorization server for agents:** would tie the connector to each provider's client registration and token format, and lose the audience binding of ADR 0004.

## Consequences

- An install needs an application registered at its provider and three settings. Runbooks give the steps per provider.
- A leaver keeps web access for at most 12 hours and agent access for at most 7 days unless an administrator removes it; immediate removal by directory is the paid edition's SCIM.
- Microsoft Entra ID needs the verified-email claim to be configured (`xms_edov`), and re-registering the application there changes everyone's subject.
- Development stages carry two methods; a test proves the production configuration cannot reach the magic-link path.
