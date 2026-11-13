import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Person } from "../components/people.js";
import type { PersonRowNotice, PersonRowStatus } from "../components/PersonRow.js";
import {
  manyPeople,
  people,
  personHanna,
  personMarieke,
  personPriya,
  personSanne,
  personTom,
  personYou,
  principalEmail,
  recordEntries,
  storyTimeZone,
} from "../fixtures.js";
import { useSimulatedPeople } from "../storybook/simulatePeople.js";
import { PeopleScreen, type PeopleScreenProps } from "./PeopleScreen.js";
import { RecordScreen } from "./RecordScreen.js";

/** m2-org-sign-in screens.md P1–P14: one story per static spec in the change's `screens/`. Actions are simulated. */
const meta: Meta = { title: "People and access" };
export default meta;
type Story = StoryObj;

const links = [
  { label: "Connected apps", href: "/account/clients" },
  { label: "People and access", href: "/admin/people", current: true },
];
const shell = { email: principalEmail, links };
const meNotConfigured: Person = { ...personYou, namedInConfiguration: false };
const withPerson = (changed: Person) => people.map((p) => (p.id === changed.id ? changed : p));

function Simulated({ shown, server, fail, ...props }: { shown: readonly Person[]; server?: readonly Person[]; fail?: boolean } & Partial<PeopleScreenProps>) {
  const { people: current, ...handlers } = useSimulatedPeople(shown, { ...(server !== undefined ? { server } : {}), ...(fail ? { fail } : {}) });
  return <PeopleScreen {...shell} {...props} people={current} {...handlers} />;
}
const row = (id: string, status?: PersonRowStatus, notice?: PersonRowNotice) => ({
  id,
  ...(status !== undefined ? { status } : {}),
  ...(notice !== undefined ? { notice } : {}),
});
const confirming = (action: "remove" | "restore" | "grant" | "withdraw"): PersonRowStatus => ({ kind: "confirming", action });

export const P1People: Story = { render: () => <Simulated shown={people} /> };
export const P2OnlyYou: Story = { render: () => <Simulated shown={[personYou]} /> };
export const P3Loading: Story = { render: () => <PeopleScreen {...shell} people={[]} state="loading" /> };
export const P4Error: Story = { render: () => <PeopleScreen {...shell} people={[]} state="error" reference="ref_8c2e5d1a90b34f67" /> };
export const P5LongList: Story = { render: () => <Simulated shown={manyPeople} /> };
export const P5bSearch: Story = { render: () => <Simulated shown={manyPeople} initial={{ query: "rossi" }} /> };
export const P5cNoMatch: Story = { render: () => <Simulated shown={manyPeople} initial={{ query: "zoltan" }} /> };
export const P5ShowAdministrators: Story = { render: () => <Simulated shown={manyPeople} initial={{ show: "administrators" }} /> };
export const P5ShowAccessRemoved: Story = { render: () => <Simulated shown={manyPeople} initial={{ show: "removed" }} /> };
export const P6ConfirmRemove: Story = { render: () => <Simulated shown={people} initial={row(personSanne.id, confirming("remove"))} /> };
export const P6bRemoving: Story = {
  render: () => <PeopleScreen {...shell} people={people} initial={row(personSanne.id, { kind: "pending", action: "remove" })} />,
};
export const P6cConfirmRemoveAdmin: Story = { render: () => <Simulated shown={people} initial={row(personMarieke.id, confirming("remove"))} /> };
export const P7Removed: Story = {
  render: () => <Simulated shown={withPerson({ ...personSanne, hasAccess: false })} initial={row(personSanne.id, undefined, { kind: "done", action: "remove" })} />,
};
const mariekeRemoved: Person = { ...personMarieke, hasAccess: false, administratorOnRestore: true };
export const P7bRemovedAdmin: Story = {
  render: () => (
    <Simulated shown={withPerson(mariekeRemoved)} initial={row(personMarieke.id, undefined, { kind: "done", action: "remove", wasAdministrator: true })} />
  ),
};
export const P8ConfirmRestore: Story = { render: () => <Simulated shown={people} initial={row(personPriya.id, confirming("restore"))} /> };
export const P8bConfirmRestoreAdmin: Story = {
  render: () => <Simulated shown={withPerson(mariekeRemoved)} initial={row(personMarieke.id, confirming("restore"))} />,
};
export const P9ConfirmGrant: Story = { render: () => <Simulated shown={people} initial={row(personTom.id, confirming("grant"))} /> };
export const P10ConfirmWithdraw: Story = { render: () => <Simulated shown={people} initial={row(personMarieke.id, confirming("withdraw"))} /> };
export const P10bConfirmWithdrawSelf: Story = {
  render: () => <Simulated shown={withPerson(meNotConfigured)} initial={row(personYou.id, confirming("withdraw"))} />,
};
export const P11Reasons: Story = { render: () => <Simulated shown={[meNotConfigured, personSanne, personTom]} /> };
export const P11cConfigured: Story = { render: () => <Simulated shown={[personYou, personHanna, personSanne]} /> };
const mariekeWithdrawn = people.map((p) => (p.id === personYou.id ? meNotConfigured : p.id === personMarieke.id ? { ...personMarieke, isAdministrator: false } : p));
export const P11bRefusedLastAdmin: Story = {
  render: () => (
    <Simulated shown={mariekeWithdrawn} initial={row(personYou.id, undefined, { kind: "refused", action: "withdraw", refusal: "last_administrator" })} />
  ),
};
/** The page is out of date: another administrator withdrew Marieke Visser's role meanwhile. Withdraw your own role to be refused. */
export const P11bOutOfDatePage: Story = { render: () => <Simulated shown={withPerson(meNotConfigured)} server={mariekeWithdrawn} /> };
export const P11bAlreadyDone: Story = {
  render: () => <Simulated shown={withPerson({ ...personSanne, hasAccess: false })} initial={row(personSanne.id, undefined, { kind: "already-done" })} />,
};
export const P12ActionError: Story = {
  render: () => <Simulated shown={people} fail initial={row(personSanne.id, undefined, { kind: "failed", action: "remove", reference: "ref_51d0c7e2a48b4c39" })} />,
};
export const P13Offline: Story = { render: () => <Simulated shown={people} fail state="offline" /> };
export const P1TestStage: Story = { render: () => <Simulated shown={people} stageName="dev" /> };

const older = Array.from({ length: 118 }, (_, i) => ({
  ...recordEntries[i % recordEntries.length]!,
  id: `act-old-${i}`,
  at: new Date(Date.parse("2026-11-08T17:00:00+01:00") - i * 5_400_000).toISOString(),
}));
export const P14Record: Story = { render: () => <RecordScreen {...shell} entries={recordEntries} timeZone={storyTimeZone} /> };
export const P14bRecordEmpty: Story = { render: () => <RecordScreen {...shell} entries={[]} /> };
export const P14RecordLong: Story = { render: () => <RecordScreen {...shell} entries={[...recordEntries, ...older]} timeZone={storyTimeZone} /> };
export const P14RecordLoading: Story = { render: () => <RecordScreen {...shell} entries={[]} state="loading" /> };
export const P14RecordError: Story = { render: () => <RecordScreen {...shell} entries={[]} state="error" reference="ref_8c2e5d1a90b34f67" /> };
export const P14RecordOffline: Story = { render: () => <RecordScreen {...shell} entries={recordEntries} state="offline" timeZone={storyTimeZone} /> };
