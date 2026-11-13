import type { Meta, StoryObj } from "@storybook/react-vite";
import { connectedClients, principalEmail } from "../fixtures.js";
import { AccessRefusedScreen, NotAdministratorScreen } from "./AccessRefusedScreen.js";
import { ConnectedClientsScreen } from "./ConnectedClientsScreen.js";
import { SignedOutScreen } from "./SignedOutScreen.js";
import { SignInScreen } from "./SignInScreen.js";

/** m2-org-sign-in screens.md S1–S5 and N1: one story per static spec in the change's `screens/`. */
const meta: Meta = { title: "Org sign-in" };
export default meta;
type Story = StoryObj;

const organisation = ["organisation"] as const;
const both = ["organisation", "magic-link"] as const;
const authorize = "/api/auth/oauth2/authorize?client_id=…";
const contact = "it-helpdesk@example.com";
const clientsLink = [{ label: "Connected apps", href: "/account/clients" }];

// S1. Sign in, production install
export const S1SignIn: Story = { render: () => <SignInScreen methods={organisation} /> };
export const S1bSignInNamed: Story = { render: () => <SignInScreen methods={organisation} organisationName="Automi" /> };
export const S1cSignInConnecting: Story = { render: () => <SignInScreen methods={organisation} next={authorize} /> };
export const S1cSignInApproving: Story = { render: () => <SignInScreen methods={organisation} next="/approve/A2H-7f3c" nextPurpose="approve" /> };
export const S1dSignInOpening: Story = { render: () => <SignInScreen methods={organisation} organisationPending /> };
export const S1eSignInError: Story = { render: () => <SignInScreen methods={organisation} notice="start-failed" reference="ref_3f9a61c2b7d04e18" /> };
export const S1fSignInUnavailable: Story = { render: () => <SignInScreen methods={organisation} notice="unavailable" /> };
export const S1SignInOffline: Story = { render: () => <SignInScreen methods={organisation} notice="offline" /> };

// S2. Sign in, development stage with both methods
export const S2SignInDevBoth: Story = { render: () => <SignInScreen methods={both} stageName="dev" /> };
export const S2SignInDevBothUnavailable: Story = { render: () => <SignInScreen methods={both} stageName="dev" notice="unavailable" /> };
export const S2SignInDevBothLinkInvalid: Story = { render: () => <SignInScreen methods={both} stageName="dev" state="invalid" email="galem@example" /> };
export const S2SignInDevBothLinkError: Story = {
  render: () => <SignInScreen methods={both} stageName="dev" state="error" email={principalEmail} reference="req_01JBX7N3K2" />,
};

// S3. Not completed, refused
export const S3aNotCompleted: Story = { render: () => <SignInScreen methods={organisation} notice="not-completed" /> };
export const S3aNotCompletedNamed: Story = { render: () => <SignInScreen methods={organisation} organisationName="Automi" notice="not-completed" /> };
export const S3a2NotCompletedDev: Story = { render: () => <SignInScreen methods={both} stageName="dev" notice="not-completed" /> };
export const S3bRefused: Story = { render: () => <AccessRefusedScreen reason="details" reference="ref_7b1e94d2c05a4f36" /> };
export const S3b2RefusedContact: Story = {
  render: () => <AccessRefusedScreen reason="details" reference="ref_7b1e94d2c05a4f36" administratorContact={contact} />,
};
export const S3bRefusedLongContact: Story = {
  render: () => (
    <AccessRefusedScreen
      reason="details"
      reference="ref_7b1e94d2c05a4f36"
      administratorContact="#a2h-administrators-and-access-requests-emea in the workspace chat, or it-helpdesk-identity-and-access@subsidiary.example.com"
    />
  ),
};
export const S3cAccessRemoved: Story = { render: () => <AccessRefusedScreen reason="access-removed" /> };
export const S3c2AccessRemovedContact: Story = { render: () => <AccessRefusedScreen reason="access-removed" administratorContact={contact} /> };

// S4. Session ended
export const S4SessionEnded: Story = { render: () => <SignInScreen methods={organisation} notice="session-ended" next="/admin/people" /> };
export const S4SessionEndedDev: Story = { render: () => <SignInScreen methods={both} stageName="dev" notice="session-ended" /> };

// S5. Signed out
export const S5SignedOut: Story = { render: () => <SignedOutScreen organisation /> };
export const S5SignedOutNamed: Story = { render: () => <SignedOutScreen organisation organisationName="Automi" /> };

// N1. Not an administrator
export const N1NotAdministrator: Story = { render: () => <NotAdministratorScreen email={principalEmail} links={clientsLink} /> };
export const N1NotAdministratorContact: Story = {
  render: () => <NotAdministratorScreen email={principalEmail} links={clientsLink} administratorContact={contact} />,
};

// Connected apps with the header links, and after withdrawing one's own role (P10)
export const ConnectedAppsWithLinks: Story = {
  render: () => (
    <ConnectedClientsScreen
      email={principalEmail}
      clients={connectedClients}
      links={[
        { label: "Connected apps", href: "/account/clients", current: true },
        { label: "People and access", href: "/admin/people" },
      ]}
    />
  ),
};
export const ConnectedAppsOwnRoleWithdrawn: Story = {
  render: () => (
    <ConnectedClientsScreen email={principalEmail} clients={connectedClients} links={[{ ...clientsLink[0]!, current: true }]} notice="own-role-withdrawn" />
  ),
};
