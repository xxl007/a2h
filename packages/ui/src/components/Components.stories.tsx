import type { Meta, StoryObj } from "@storybook/react-vite";
import { claudeAi, claudeCode, connectedClients, longName, preRegistered } from "../fixtures.js";
import { Button, ButtonLink, TextLink } from "./Button.js";
import { ClientIdentity } from "./ClientIdentity.js";
import { ClientRow } from "./ClientRow.js";
import { Notice } from "./Notice.js";
import { Skeleton } from "./Skeleton.js";
import { TextField } from "./TextField.js";

const meta: Meta = { title: "Components", parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj;

const column = { display: "flex", flexDirection: "column", gap: 16, maxWidth: 480 } as const;
const firstClient = connectedClients[0]!;
const neverUsed = connectedClients[2]!;

export const Buttons: Story = {
  render: () => (
    <div style={column}>
      <Button>Email me a sign-in link</Button>
      <Button variant="ghost">Don't connect</Button>
      <Button isPending pendingLabel="Sending the link…">Email me a sign-in link</Button>
      <Button isDisabled>Disabled</Button>
      <ButtonLink href="#">Send me a new link</ButtonLink>
      <p>
        Inline <TextLink href="#">text link</TextLink> in a sentence.
      </p>
    </div>
  ),
};

export const TextFields: Story = {
  render: () => (
    <div style={column}>
      <TextField label="Email address" name="a" type="email" autoComplete="email" />
      <TextField label="Email address" name="b" type="email" defaultValue="galem@example" errorMessage="Enter an email address in the form name@example.com." />
      <TextField label="Email address" name="c" type="email" errorMessage="Enter your email address." />
    </div>
  ),
};

export const Notices: Story = {
  render: () => (
    <div style={column}>
      <Notice tone="danger" title="The link was not sent" reference="req_01JBX7N3K2">
        <p>Something went wrong on our side. Your address is still in the field; try again.</p>
      </Notice>
      <Notice tone="success" title="Another link is on its way"><p>Use the newest one.</p></Notice>
      <Notice tone="pending" title="Pending"><p>Status in words.</p></Notice>
      <Notice tone="neutral" title="You're offline"><p>Your address is kept.</p></Notice>
      <Notice tone="platform" title="You still approve every question"><p>Nothing reaches a person without your yes.</p></Notice>
    </div>
  ),
};

export const ClientIdentities: Story = {
  render: () => (
    <div style={column}>
      <ClientIdentity client={claudeAi} />
      <ClientIdentity client={claudeCode} />
      <ClientIdentity client={preRegistered} />
      <ClientIdentity client={longName} />
    </div>
  ),
};

const rowList = (node: React.ReactNode) => <ul style={{ listStyle: "none", padding: 0, maxWidth: 640 }}>{node}</ul>;

export const ClientRowIdle: Story = { render: () => rowList(<ClientRow client={firstClient} />) };
export const ClientRowNeverUsed: Story = { render: () => rowList(<ClientRow client={neverUsed} />) };
export const ClientRowConfirming: Story = { render: () => rowList(<ClientRow client={firstClient} initialState="confirming" />) };
export const ClientRowRevoking: Story = { render: () => rowList(<ClientRow client={firstClient} initialState="revoking" />) };
export const ClientRowError: Story = {
  render: () => rowList(<ClientRow client={firstClient} initialState="error" reference="req_01JBX7N3K2" />),
};

export const Skeletons: Story = {
  render: () => (
    <div style={column} role="status" aria-label="Loading">
      <Skeleton height={20} width="40%" />
      <Skeleton height={16} width="60%" />
    </div>
  ),
};
