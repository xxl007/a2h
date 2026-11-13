import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactNode } from "react";
import { personHanna, personMarieke, personPriya, personSanne, personYou, principalEmail, recordEntries, storyTimeZone } from "../fixtures.js";
import { ActionRecord } from "./ActionRecord.js";
import { AdminNav } from "./AdminNav.js";
import { AuthShell } from "./AuthShell.js";
import { ChoiceGroup } from "./ChoiceGroup.js";
import { PersonRow } from "./PersonRow.js";
import { SearchField } from "./SearchField.js";

const meta: Meta = { title: "People components" };
export default meta;
type Story = StoryObj;

const frame = (node: ReactNode) => <main style={{ padding: 16, maxWidth: 640 }}>{node}</main>;
const list = (node: ReactNode) => frame(<ul style={{ listStyle: "none", padding: 0, margin: 0 }}>{node}</ul>);

export const HeaderLinks: Story = {
  render: () => (
    <AuthShell
      account={{ email: principalEmail }}
      links={[
        { label: "Connected apps", href: "/account/clients" },
        { label: "People and access", href: "/admin/people", current: true },
      ]}
    >
      <h1 style={{ margin: 0 }}>Page</h1>
    </AuthShell>
  ),
};
export const HeaderLinksNotAdministrator: Story = {
  render: () => (
    <AuthShell account={{ email: principalEmail }} links={[{ label: "Connected apps", href: "/account/clients", current: true }]} stageName="dev">
      <h1 style={{ margin: 0 }}>Page</h1>
    </AuthShell>
  ),
};
export const AdminNavPeople: Story = { render: () => frame(<AdminNav current="people" />) };
export const AdminNavRecord: Story = { render: () => frame(<AdminNav current="record" />) };

function Search({ start }: { start: string }) {
  const [value, setValue] = useState(start);
  return <SearchField label="Search people" description="By name or email address." value={value} onChange={setValue} clearLabel="Clear" clearName="Clear search" />;
}
export const SearchFieldEmpty: Story = { render: () => frame(<Search start="" />) };
export const SearchFieldFilled: Story = { render: () => frame(<Search start="rossi" />) };

function Show({ start }: { start: "everyone" | "administrators" | "removed" }) {
  const [value, setValue] = useState(start);
  return (
    <ChoiceGroup
      label="Show"
      value={value}
      onChange={setValue}
      options={[
        { value: "everyone", label: "Everyone (214)" },
        { value: "administrators", label: "Administrators (3)" },
        { value: "removed", label: "Access removed (5)" },
      ]}
    />
  );
}
export const ChoiceGroupEveryone: Story = { render: () => frame(<Show start="everyone" />) };
export const ChoiceGroupAdministrators: Story = { render: () => frame(<Show start="administrators" />) };
export const ChoiceGroupAccessRemoved: Story = { render: () => frame(<Show start="removed" />) };

export const PersonRowKinds: Story = {
  render: () =>
    list(
      <>
        <PersonRow person={personSanne} onlyAdministrator={false} />
        <PersonRow person={personPriya} onlyAdministrator={false} />
        <PersonRow person={{ ...personMarieke, hasAccess: false, administratorOnRestore: true }} onlyAdministrator={false} />
        <PersonRow person={{ ...personMarieke, id: "u-m2" }} onlyAdministrator={false} />
        <PersonRow person={personHanna} onlyAdministrator={false} />
        <PersonRow person={{ ...personYou, namedInConfiguration: false, id: "u-y1" }} onlyAdministrator={false} />
        <PersonRow person={personYou} onlyAdministrator={false} />
        <PersonRow person={{ ...personYou, namedInConfiguration: false, id: "u-y2" }} onlyAdministrator />
      </>,
    ),
};
export const PersonRowLongNameNoName: Story = {
  render: () =>
    list(
      <>
        <PersonRow
          person={{ ...personSanne, name: "Maximiliane-Friederike von Hohenzollern-Sigmaringen-Wolkenstein de la Fontaine", email: "maximiliane-friederike.von.hohenzollern-sigmaringen@subsidiary.example.com" }}
          onlyAdministrator={false}
        />
        <PersonRow person={{ ...personPriya, name: personPriya.email, hasAccess: true }} onlyAdministrator={false} />
      </>,
    ),
};
export const PersonRowConfirming: Story = { render: () => list(<PersonRow person={personSanne} onlyAdministrator={false} status={{ kind: "confirming", action: "remove" }} />) };
export const PersonRowPending: Story = { render: () => list(<PersonRow person={personSanne} onlyAdministrator={false} status={{ kind: "pending", action: "grant" }} />) };
export const PersonRowDone: Story = {
  render: () =>
    list(
      <>
        <PersonRow person={{ ...personSanne, hasAccess: false }} onlyAdministrator={false} notice={{ kind: "done", action: "remove" }} />
        <PersonRow person={{ ...personPriya, hasAccess: true }} onlyAdministrator={false} notice={{ kind: "done", action: "restore" }} />
        <PersonRow person={{ ...personSanne, id: "u-s2", isAdministrator: true }} onlyAdministrator={false} notice={{ kind: "done", action: "grant" }} />
        <PersonRow person={{ ...personMarieke, isAdministrator: false }} onlyAdministrator={false} notice={{ kind: "done", action: "withdraw" }} />
      </>,
    ),
};
export const PersonRowRefused: Story = {
  render: () =>
    list(
      <>
        <PersonRow person={personMarieke} onlyAdministrator={false} notice={{ kind: "refused", action: "remove", refusal: "last_administrator" }} />
        <PersonRow person={personHanna} onlyAdministrator={false} notice={{ kind: "refused", action: "withdraw", refusal: "named_in_configuration" }} />
        <PersonRow person={personYou} onlyAdministrator={false} notice={{ kind: "refused", action: "remove", refusal: "own_access" }} />
      </>,
    ),
};
export const PersonRowFailed: Story = {
  render: () =>
    list(
      <>
        <PersonRow person={personSanne} onlyAdministrator={false} notice={{ kind: "failed", action: "remove", reference: "ref_51d0c7e2a48b4c39" }} />
        <PersonRow person={personPriya} onlyAdministrator={false} notice={{ kind: "failed", action: "restore" }} />
        <PersonRow person={{ ...personSanne, id: "u-s3" }} onlyAdministrator={false} notice={{ kind: "failed", action: "grant" }} />
        <PersonRow person={personMarieke} onlyAdministrator={false} notice={{ kind: "failed", action: "withdraw" }} />
      </>,
    ),
};
export const ActionRecordEntries: Story = { render: () => frame(<ActionRecord entries={recordEntries} timeZone={storyTimeZone} />) };
