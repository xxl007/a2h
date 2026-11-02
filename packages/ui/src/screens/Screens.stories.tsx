import type { Meta, StoryObj } from "@storybook/react-vite";
import { claudeAi, claudeCode, connectedClients, longName, principalEmail } from "../fixtures.js";
import { CheckEmailScreen, LinkExpiredScreen } from "./CheckEmailScreen.js";
import { ConnectedClientsScreen } from "./ConnectedClientsScreen.js";
import { ConsentScreen } from "./ConsentScreen.js";
import { SignedOutScreen } from "./SignedOutScreen.js";
import { SignInScreen } from "./SignInScreen.js";

const meta: Meta = { title: "Screens" };
export default meta;
type Story = StoryObj;

const ref = "req_01JBX7N3K2";
const authorize = "/api/auth/oauth2/authorize?client_id=…";

// 1. Sign in (/sign-in)
export const SignIn: Story = { render: () => <SignInScreen /> };
export const SignInConnecting: Story = { render: () => <SignInScreen next={authorize} /> };
export const SignInSubmitting: Story = { render: () => <SignInScreen state="submitting" email={principalEmail} /> };
export const SignInInvalidFormat: Story = { render: () => <SignInScreen state="invalid" email="galem@example" /> };
export const SignInInvalidEmpty: Story = { render: () => <SignInScreen state="invalid" invalidReason="empty" /> };
export const SignInError: Story = { render: () => <SignInScreen state="error" email={principalEmail} reference={ref} /> };
export const SignInRateLimited: Story = { render: () => <SignInScreen state="rate-limited" email={principalEmail} /> };
export const SignInOffline: Story = { render: () => <SignInScreen state="offline" email={principalEmail} /> };
export const SignInTestStage: Story = { render: () => <SignInScreen stageName="pr-52" /> };

// 2. Check your email (/sign-in/sent) and the expired link (/sign-in/expired)
export const CheckEmail: Story = { render: () => <CheckEmailScreen email={principalEmail} /> };
export const CheckEmailNoAddress: Story = { render: () => <CheckEmailScreen /> };
export const CheckEmailTestStage: Story = { render: () => <CheckEmailScreen email={principalEmail} stageName="pr-52" /> };
export const CheckEmailResending: Story = { render: () => <CheckEmailScreen email={principalEmail} state="resending" /> };
export const CheckEmailResent: Story = { render: () => <CheckEmailScreen email={principalEmail} state="resent" /> };
export const CheckEmailError: Story = { render: () => <CheckEmailScreen email={principalEmail} state="error" reference={ref} /> };
export const CheckEmailOffline: Story = { render: () => <CheckEmailScreen email={principalEmail} state="offline" /> };
export const LinkExpired: Story = { render: () => <LinkExpiredScreen /> };

// 3. Consent (/consent)
const consent = { email: principalEmail, scopes: ["a2h", "offline_access"] as const };
export const Consent: Story = { render: () => <ConsentScreen {...consent} client={claudeAi} returnOrigin="claude.ai" /> };
export const ConsentDynamicLocal: Story = { render: () => <ConsentScreen {...consent} client={claudeCode} returnOrigin="localhost" /> };
export const ConsentLongName: Story = {
  render: () => <ConsentScreen email={principalEmail} scopes={["a2h"]} client={longName} returnOrigin={longName.origin} />,
};
export const ConsentAccepting: Story = { render: () => <ConsentScreen {...consent} client={claudeAi} returnOrigin="claude.ai" state="accepting" /> };
export const ConsentError: Story = {
  render: () => <ConsentScreen {...consent} client={claudeAi} returnOrigin="claude.ai" state="error" reference={ref} />,
};
export const ConsentOffline: Story = { render: () => <ConsentScreen {...consent} client={claudeAi} returnOrigin="claude.ai" state="offline" /> };
export const ConsentInvalid: Story = { render: () => <ConsentScreen email={principalEmail} state="invalid" reference={ref} /> };
export const ConsentExpired: Story = { render: () => <ConsentScreen email={principalEmail} state="expired" /> };
export const ConsentDeclinedFallback: Story = { render: () => <ConsentScreen {...consent} client={claudeAi} state="declined" /> };

// 4. Connected apps (/account/clients)
const account = { email: principalEmail };
export const ConnectedApps: Story = { render: () => <ConnectedClientsScreen {...account} clients={connectedClients} /> };
export const ConnectedAppsEmpty: Story = { render: () => <ConnectedClientsScreen {...account} clients={[]} /> };
export const ConnectedAppsLoading: Story = { render: () => <ConnectedClientsScreen {...account} state="loading" /> };
export const ConnectedAppsError: Story = { render: () => <ConnectedClientsScreen {...account} state="error" reference={ref} /> };
export const ConnectedAppsOffline: Story = { render: () => <ConnectedClientsScreen {...account} state="offline" clients={connectedClients} /> };
export const ConnectedAppsConfirming: Story = {
  render: () => (
    <ConnectedClientsScreen {...account} clients={connectedClients} rowState={{ clientId: "c-claude-ai", state: "confirming" }} />
  ),
};
export const ConnectedAppsRevokeError: Story = {
  render: () => (
    <ConnectedClientsScreen {...account} clients={connectedClients} reference={ref} rowState={{ clientId: "c-claude-ai", state: "error" }} />
  ),
};
export const ConnectedAppsDisconnected: Story = {
  render: () => <ConnectedClientsScreen {...account} clients={connectedClients.slice(1)} initialDisconnected="Claude" />,
};
/** Interactive: Disconnect, confirm; the first revoke fails, the second succeeds. */
export const ConnectedAppsInteractive: Story = {
  render: () => {
    let attempts = 0;
    const onRevoke = async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      attempts += 1;
      if (attempts === 1) throw new Error("simulated failure");
    };
    return <ConnectedClientsScreen {...account} clients={connectedClients} onRevoke={onRevoke} />;
  },
};

// 5. Signed out (/signed-out)
export const SignedOut: Story = { render: () => <SignedOutScreen /> };
