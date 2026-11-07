# Spec Delta

## MODIFIED Requirements

### Requirement: Sign-out revokes
A signed-in principal SHALL be able to see the clients that hold consent and to revoke any of them, and signing out SHALL revoke the session.

#### Scenario: Client revoked
- **WHEN** the principal revokes a client's consent
- **THEN** that client's refresh tokens are invalid from then on and its next refresh fails, while access tokens already issued expire at their own expiry

#### Scenario: Revoke repeated
- **WHEN** the principal revokes a client that is already disconnected, for example from a second tab
- **THEN** the page shows the client as disconnected, nothing else changes, and the event is logged as already revoked, not as an error
