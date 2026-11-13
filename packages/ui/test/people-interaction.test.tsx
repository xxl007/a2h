// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { manyPeople, people, personMarieke, personSanne, personTom, personYou, principalEmail } from "../src/fixtures.js";
import { PeopleScreen, type Person, type PersonActionResult } from "../src/index.js";

/**
 * Interaction tests for the administrators' page (screens.md P6–P13, "Announcements", "Keyboard order
 * and focus"). @testing-library/react with user-event on jsdom; the server is a set of promises the
 * test resolves by hand, so "while it runs" can be observed.
 */

type Handler = (id: string) => Promise<PersonActionResult>;
interface Deferred {
  id: string;
  resolve: (r: PersonActionResult) => void;
  reject: (e: unknown) => void;
}

function server() {
  const calls: Deferred[] = [];
  const handler: Handler = (id) =>
    new Promise<PersonActionResult>((resolve, reject) => {
      calls.push({ id, resolve, reject });
    });
  return { calls, handler };
}

const meNotConfigured: Person = { ...personYou, namedInConfiguration: false };
const withPerson = (list: readonly Person[], changed: Person) => list.map((p) => (p.id === changed.id ? changed : p));

function setup(list: readonly Person[] = people) {
  const s = server();
  const user = userEvent.setup();
  render(
    <PeopleScreen
      email={principalEmail}
      people={list}
      onRemoveAccess={s.handler}
      onRestoreAccess={s.handler}
      onMakeAdministrator={s.handler}
      onWithdrawAdministrator={s.handler}
    />,
  );
  return { ...s, user };
}

const rowOf = (name: string) => screen.getByRole("heading", { level: 2, name: new RegExp(`^${name}`) }).closest("li")!;
const settle = () => act(() => Promise.resolve());
const pause = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

afterEach(cleanup);

describe("confirmations (P6–P10)", () => {
  it("opening moves focus to the panel named by its question; Escape closes it and returns focus", async () => {
    const { user } = setup();
    const opener = screen.getByRole("button", { name: /Remove access for Sanne Kok/ });
    await user.click(opener);
    const panel = screen.getByRole("group", { name: "Remove Sanne Kok's access?" });
    expect(document.activeElement).toBe(panel);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Remove access for Sanne Kok/ }));
  });

  it("the way out closes it and returns focus to the opening button", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Make administrator: Tom Aubert/ }));
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Make administrator: Tom Aubert/ }));
  });

  it("one confirmation open at a time: opening another closes the first", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /Remove access for Sanne Kok/ }));
    await user.click(screen.getByRole("button", { name: /Make administrator: Tom Aubert/ }));
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Make Tom Aubert an administrator?" })).toBeTruthy();
  });

  it("in progress: the confirm button is busy, the way out unavailable, Escape does nothing", async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole("button", { name: /Remove access for Sanne Kok/ }));
    await user.click(screen.getByRole("button", { name: "Remove access" }));
    expect(calls).toHaveLength(1);
    const panel = screen.getByRole("group", { name: "Remove Sanne Kok's access?" });
    expect(within(panel).getByRole("button", { name: "Removing…" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Keep access" }).hasAttribute("disabled")).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("group", { name: "Remove Sanne Kok's access?" })).toBeTruthy();
  });
});

describe("what the server answers (confirm mapping)", () => {
  it("done: polite notice in the row, focus on the row's name, count line updated", async () => {
    const { user, calls } = setup();
    expect(screen.getByText("6 people · 2 administrators · 1 with access removed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Remove access for Sanne Kok/ }));
    await user.click(screen.getByRole("button", { name: "Remove access" }));
    await act(() => { calls[0]!.resolve({ ok: true, people: withPerson(people, { ...personSanne, hasAccess: false }) }); return Promise.resolve(); });
    const row = rowOf("Sanne Kok");
    const notice = within(row).getByRole("status");
    expect(notice.textContent).toContain("Sanne Kok's access is removed");
    expect(document.activeElement).toBe(within(row).getByRole("heading", { level: 2 }));
    expect(within(row).getByRole("button", { name: /Restore access for Sanne Kok/ })).toBeTruthy();
    expect(screen.getByText("6 people · 2 administrators · 2 with access removed")).toBeTruthy();
  });

  it("refused: danger notice (alert) in the row, focus on it, list refreshed from the answer", async () => {
    const { user, calls } = setup(withPerson(people, meNotConfigured));
    await user.click(screen.getByRole("button", { name: /Withdraw administrator role from Galem L\./ }));
    await user.click(screen.getByRole("button", { name: "Withdraw my role" }));
    const refreshed = withPerson(withPerson(people, meNotConfigured), { ...personMarieke, isAdministrator: false });
    await act(() => { calls[0]!.resolve({ ok: false, refusal: "last_administrator", people: refreshed }); return Promise.resolve(); });
    const alert = within(rowOf("Galem L.")).getByRole("alert");
    expect(alert.textContent).toContain("You are still an administrator");
    expect(document.activeElement).toBe(alert);
    expect(within(rowOf("Marieke Visser")).queryByText("Administrator")).toBeNull();
  });

  it("rejected: failed notice with its reference, focus on it, the row's buttons back", async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole("button", { name: /Remove access for Sanne Kok/ }));
    await user.click(screen.getByRole("button", { name: "Remove access" }));
    await act(() => { calls[0]!.reject(Object.assign(new Error("x"), { reference: "ref_51d0c7e2" })); return Promise.resolve(); });
    const alert = within(rowOf("Sanne Kok")).getByRole("alert");
    expect(alert.textContent).toContain("Sanne Kok still has access");
    expect(alert.textContent).toContain("Removing access did not go through");
    expect(alert.textContent).toContain("ref_51d0c7e2");
    expect(document.activeElement).toBe(alert);
    expect(screen.getByRole("button", { name: /Remove access for Sanne Kok/ })).toBeTruthy();
  });

  it("already done by someone else: neutral notice, focus on the name", async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole("button", { name: /Remove access for Sanne Kok/ }));
    await user.click(screen.getByRole("button", { name: "Remove access" }));
    await act(() => { calls[0]!.resolve({ ok: true, alreadyDone: true, people: withPerson(people, { ...personSanne, hasAccess: false }) }); return Promise.resolve(); });
    const row = rowOf("Sanne Kok");
    expect(within(row).getByRole("status").textContent).toContain("Already done");
    expect(document.activeElement).toBe(within(row).getByRole("heading", { level: 2 }));
  });

  it("own role withdrawn: the row stays busy until the app leaves the page", async () => {
    const { user, calls } = setup(withPerson(people, meNotConfigured));
    await user.click(screen.getByRole("button", { name: /Withdraw administrator role from Galem L\./ }));
    await user.click(screen.getByRole("button", { name: "Withdraw my role" }));
    await act(() => { calls[0]!.resolve({ ok: true, people: withPerson(people, { ...meNotConfigured, isAdministrator: false }) }); return Promise.resolve(); });
    const panel = screen.getByRole("group", { name: "Withdraw your own administrator role?" });
    expect(within(panel).getByRole("button", { name: "Saving…" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Stay an administrator" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("another row while an action runs (review finding 1)", () => {
  it("the running row stays busy, its action is not offered twice, and its answer does not close the other row's confirmation or take focus from it", async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole("button", { name: /Remove access for Sanne Kok/ }));
    await user.click(screen.getByRole("button", { name: "Remove access" }));
    // Another row's confirmation can open (one confirmation open at a time; a running action is not a confirmation).
    await user.click(screen.getByRole("button", { name: /Make administrator: Tom Aubert/ }));
    const sanne = rowOf("Sanne Kok");
    expect(within(sanne).getByRole("button", { name: "Removing…" })).toBeTruthy();
    expect(within(sanne).queryByRole("button", { name: /Remove access for Sanne Kok/ })).toBeNull();
    const tomPanel = screen.getByRole("group", { name: "Make Tom Aubert an administrator?" });
    expect(document.activeElement).toBe(tomPanel);

    await act(() => { calls[0]!.resolve({ ok: true, people: withPerson(people, { ...personSanne, hasAccess: false }) }); return Promise.resolve(); });
    expect(screen.getByRole("group", { name: "Make Tom Aubert an administrator?" })).toBe(tomPanel);
    expect(document.activeElement).toBe(tomPanel);
    expect(within(rowOf("Sanne Kok")).getByRole("status").textContent).toContain("Sanne Kok's access is removed");

    // The second action runs on the refreshed list and reports in its own row.
    await user.click(within(tomPanel).getByRole("button", { name: "Make administrator" }));
    const sanneRemoved = withPerson(people, { ...personSanne, hasAccess: false });
    await act(() => { calls[1]!.resolve({ ok: true, people: withPerson(sanneRemoved, { ...personTom, isAdministrator: true }) }); return Promise.resolve(); });
    expect(calls.map((c) => c.id)).toEqual([personSanne.id, personTom.id]);
    expect(within(rowOf("Tom Aubert")).getByRole("status").textContent).toContain("Tom Aubert is now an administrator");
    expect(document.activeElement).toBe(within(rowOf("Tom Aubert")).getByRole("heading", { level: 2 }));
  });

  it("an action that finishes while the other row is idle moves focus as usual", async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole("button", { name: /Remove access for Sanne Kok/ }));
    await user.click(screen.getByRole("button", { name: "Remove access" }));
    await user.click(screen.getByRole("button", { name: /Make administrator: Tom Aubert/ }));
    await user.keyboard("{Escape}");
    await act(() => { calls[0]!.resolve({ ok: true, people: withPerson(people, { ...personSanne, hasAccess: false }) }); return Promise.resolve(); });
    expect(document.activeElement).toBe(within(rowOf("Sanne Kok")).getByRole("heading", { level: 2 }));
  });
});

describe("long list (P5)", () => {
  it("the Showing line is a status that speaks after typing pauses, not per keystroke", async () => {
    const { user } = setup(manyPeople);
    await settle();
    const status = () => screen.getAllByRole("status").find((s) => s.textContent?.startsWith("Showing"))!;
    expect(status().textContent).toBe("Showing 50 of 214 people");
    await user.type(screen.getByRole("searchbox", { name: "Search people" }), "ross");
    expect(status().textContent).toBe("Showing 50 of 214 people");
    await pause(600);
    expect(status().textContent).toMatch(/^Showing \d+ of \d+ people matching “ross”$/);
    await user.keyboard("{Escape}");
    await pause(600);
    expect(status().textContent).toBe("Showing 50 of 214 people");
  });

  it("Show 50 more moves focus to the first newly shown name", async () => {
    const { user } = setup(manyPeople);
    await settle();
    await user.click(screen.getByRole("button", { name: "Show 50 more" }));
    const sorted = [...manyPeople].sort((a, b) => a.name.localeCompare(b.name));
    expect(document.activeElement?.textContent).toContain(sorted[50]!.name);
  });
});
