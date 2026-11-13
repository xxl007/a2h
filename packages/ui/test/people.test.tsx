import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { people, principalEmail, recordEntries, storyTimeZone } from "../src/fixtures.js";
import {
  ActionRecord,
  AdminNav,
  ChoiceGroup,
  copy,
  filterPeople,
  peopleCounts,
  PeopleScreen,
  personOffers,
  PersonRow,
  recordSentence,
  RecordScreen,
  SearchField,
  type Person,
} from "../src/index.js";

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ");

const base: Person = {
  id: "u-sanne",
  name: "Sanne Kok",
  email: "sanne.kok@example.com",
  hasAccess: true,
  isAdministrator: false,
  isYou: false,
  namedInConfiguration: false,
  administratorOnRestore: false,
};
const person = (over: Partial<Person>): Person => ({ ...base, ...over });
const r = copy.people.reasons;
const row = (p: Person, props: Partial<Parameters<typeof PersonRow>[0]> = {}) =>
  renderToStaticMarkup(
    <ul>
      <PersonRow person={p} onlyAdministrator={false} recordHref="/admin/record" {...props} />
    </ul>,
  );

describe("what a row offers (screens.md P1 table)", () => {
  it.each([
    ["has access, not an administrator", person({}), false, "remove", "grant", []],
    ["access removed", person({ hasAccess: false }), false, "restore", undefined, []],
    ["access removed, was an administrator", person({ hasAccess: false, administratorOnRestore: true }), false, "restore", undefined, [r.removedAdministrator]],
    ["another administrator", person({ isAdministrator: true }), false, "remove", "withdraw", []],
    ["another administrator, named in configuration", person({ isAdministrator: true, namedInConfiguration: true }), false, "remove", undefined, [r.configured]],
    ["you", person({ isYou: true, isAdministrator: true }), false, undefined, "withdraw", [r.ownAccess]],
    ["you, named in configuration", person({ isYou: true, isAdministrator: true, namedInConfiguration: true }), true, undefined, undefined, [r.ownAccess, r.configuredYou]],
    ["you, the only administrator", person({ isYou: true, isAdministrator: true }), true, undefined, undefined, [r.ownAccess, r.onlyAdministrator]],
  ] as const)("%s", (_name, p, only, access, role, reasons) => {
    const offers = personOffers(p, only);
    expect(offers.access).toBe(access);
    expect(offers.role).toBe(role);
    expect(offers.reasons).toEqual(reasons);
  });

  it("a person whose access is removed is not shown or counted as an administrator", () => {
    const removed = person({ hasAccess: false, isAdministrator: true, administratorOnRestore: true });
    expect(text(row(removed))).not.toContain("Administrator ");
    expect(peopleCounts([removed, person({ id: "b" })])).toEqual({ all: 2, administrators: 0, removed: 1 });
  });
});

describe("PersonRow", () => {
  it("a list item with an h2, pills in words, buttons named with the person and their address", () => {
    const html = row(person({}));
    expect(html).toMatch(/<li[^>]*>.*<h2[^>]*>Sanne Kok<\/h2>/s);
    expect(text(html)).toContain("sanne.kok@example.com Has access");
    expect(html).toContain('aria-label="Remove access for Sanne Kok (sanne.kok@example.com)"');
    expect(html).toContain('aria-label="Make administrator: Sanne Kok (sanne.kok@example.com)"');
    const admin = row(person({ isAdministrator: true }));
    expect(text(admin)).toContain("Has access Administrator");
    expect(admin).toContain('aria-label="Withdraw administrator role from Sanne Kok (sanne.kok@example.com)"');
    expect(row(person({ hasAccess: false }))).toContain('aria-label="Restore access for Sanne Kok (sanne.kok@example.com)"');
    expect(text(row(person({ hasAccess: false })))).toContain("Access removed");
  });

  it("no disabled button stands in for an action that cannot be taken: the reason is a sentence", () => {
    const html = row(person({ isYou: true, isAdministrator: true }), { onlyAdministrator: true });
    expect(html).not.toContain("<button");
    expect(text(html)).toContain("Sanne Kok (you)");
    expect(text(html)).toContain(r.ownAccess);
    expect(text(html)).toContain(r.onlyAdministrator);
  });

  it("the confirmation is a group named by its question, in place of the row's buttons; no dialog", () => {
    const html = row(person({}), { status: { kind: "confirming", action: "remove" } });
    const id = /role="group"[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`<p id="${id}"`);
    expect(html).not.toMatch(/role="(alert)?dialog"|<dialog/);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain("aria-label=\"Make administrator");
    const t = text(html);
    expect(t).toContain("Remove Sanne Kok's access?");
    expect(t).toContain(copy.people.confirm.remove.body);
    expect(t).toMatch(/Remove access\s+Keep access/);
  });

  it.each([
    ["remove an administrator", person({ isAdministrator: true }), "remove", "They also stop being an administrator while their access is removed", "Keep access"],
    ["restore", person({ hasAccess: false }), "restore", "work again without asking them anew. This goes in the record", "Keep removed"],
    ["restore a former administrator", person({ hasAccess: false, administratorOnRestore: true }), "restore", "They will be an administrator again.", "Keep removed"],
    ["make administrator", person({}), "grant", "They will not see anyone's requests, answers or rules.", "Not now"],
    ["withdraw", person({ isAdministrator: true }), "withdraw", "can no longer open this page", "Keep as administrator"],
    ["withdraw own", person({ isAdministrator: true, isYou: true }), "withdraw", "Withdraw your own administrator role?", "Stay an administrator"],
  ] as const)("confirmation copy: %s", (_n, p, action, sentence, wayOut) => {
    const t = text(row(p, { status: { kind: "confirming", action } }));
    expect(t).toContain(sentence);
    expect(t).toContain(wayOut);
    expect(t).toContain("This goes in the record of actions.");
  });

  it("in progress: the confirm button is busy and says what is happening", () => {
    const html = row(person({}), { status: { kind: "pending", action: "remove" } });
    expect(text(html)).toContain("Removing…");
    expect(html).toMatch(/<button[^>]*(disabled|aria-disabled="true")[^>]*>Keep access/);
  });

  it("done: a polite notice in the row with a link to the record; the name can take focus", () => {
    const html = row(person({ hasAccess: false }), { notice: { kind: "done", action: "remove" } });
    expect(html).toContain('role="status"');
    expect(html).toMatch(/<h2[^>]*tabindex="-1"/);
    expect(text(html)).toContain("Sanne Kok's access is removed");
    expect(html).toMatch(/This is in the <a [^>]*href="\/admin\/record"[^>]*>record of actions<\/a>\./);
    expect(text(row(person({ hasAccess: false, administratorOnRestore: true }), { notice: { kind: "done", action: "remove", wasAdministrator: true } }))).toContain(
      "and are not an administrator meanwhile",
    );
  });

  it("refused by the server and failed: assertive notices that can take focus", () => {
    const refused = row(person({ isYou: true, isAdministrator: true }), {
      onlyAdministrator: true,
      notice: { kind: "refused", action: "withdraw", refusal: "last_administrator" },
    });
    expect(refused).toMatch(/role="alert"[^>]*tabindex="-1"|tabindex="-1"[^>]*role="alert"/);
    expect(text(refused)).toContain("You are still an administrator Your role was not withdrawn: A2H would be left with no administrator.");
    expect(text(row(person({ isAdministrator: true }), { notice: { kind: "refused", action: "remove", refusal: "last_administrator" } }))).toContain(
      "Sanne Kok still has access Their access was not removed",
    );
    expect(text(row(person({ isYou: true }), { notice: { kind: "refused", action: "remove", refusal: "own_access" } }))).toContain(
      "You still have access You can't remove your own access. Nothing was changed.",
    );
    const failed = row(person({}), { notice: { kind: "failed", action: "remove", reference: "ref_51d0c7e2a48b4c39" } });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain("Sanne Kok still has access Removing access did not go through. Nothing was changed. Try again. Reference ref_51d0c7e2a48b4c39");
    expect(failed).toContain('aria-label="Remove access for');
    expect(text(row(person({}), { notice: { kind: "already-done" } }))).toContain("Already done Another administrator did this a moment ago.");
  });
});

describe("PeopleScreen", () => {
  const screen = (props: Partial<Parameters<typeof PeopleScreen>[0]> = {}) =>
    renderToStaticMarkup(<PeopleScreen email={principalEmail} people={people} {...props} />);

  it("the list: named, sorted by name, counted in words, with the administrators' navigation", () => {
    const html = screen();
    const t = text(html);
    expect(html).toMatch(/<h1[^>]*>People and access<\/h1>/);
    expect(html).toContain('<nav aria-label="Administration"');
    expect(html).toMatch(/<a [^>]*aria-current="page"[^>]*>People<\/a>/);
    expect(html).toMatch(/<ul[^>]*aria-label="People"/);
    expect(t).toContain("6 people · 2 administrators · 1 with access removed");
    const names = [...html.matchAll(/<h2[^>]*>([^<]+)/g)].map((m) => m[1]);
    expect(names).toEqual([...names].sort((a, b) => a!.localeCompare(b!)));
    expect(names).toHaveLength(6);
    expect(t).toContain(copy.people.note);
  });

  it("never shows last activity: the shape has no such field and extra data is not rendered", () => {
    // @ts-expect-error Person has no last-activity field (screens.md "Props for the web dev").
    const leaky: Person = { ...base, lastSignedInAt: "2026-11-10T08:00:00Z" };
    const html = screen({ people: [{ ...leaky, lastActiveAt: "LEAK-2026-11-09" } as Person, person({ id: "me", isYou: true, isAdministrator: true })] });
    expect(html).not.toContain("LEAK");
    expect(html).not.toContain("2026-11-10");
    expect(html).not.toContain("<time");
    expect(text(html)).not.toMatch(/last (active|signed|seen)/i);
  });

  it("only you: your row, then why nobody else is listed; no count, no tools", () => {
    const t = text(screen({ people: [person({ isYou: true, isAdministrator: true, namedInConfiguration: true })] }));
    expect(t).toContain("You're the only person so far");
    expect(t).not.toContain("1 person ·");
    expect(t).not.toContain("Search people");
  });

  it("loading, error, offline", () => {
    const loading = screen({ state: "loading", people: [] });
    expect(loading).toMatch(/role="status"[^>]*aria-label="Loading people"|aria-label="Loading people"[^>]*role="status"/);
    expect(loading).toContain("People and access");
    const error = screen({ state: "error", people: [], reference: "ref_8c2e5d1a90b34f67" });
    expect(error).toContain('role="alert"');
    expect(text(error)).toContain("People could not be loaded Nobody's access was changed. Reload the page to try again. Reference ref_8c2e5d1a90b34f67");
    expect(error).toMatch(/<a [^>]*>Reload<\/a>/);
    const offline = screen({ state: "offline" });
    expect(text(offline)).toContain("You're offline This list may be out of date. Changing access needs a connection.");
    expect(offline).toContain('aria-label="Remove access for');
  });

  it("without JavaScript the whole long list is rendered and no tool is", () => {
    const many = Array.from({ length: 60 }, (_, i) => person({ id: `p${i}`, name: `Person ${String(i).padStart(2, "0")}`, email: `p${i}@example.com` }));
    const html = screen({ people: many });
    expect(html.match(/<h2/g)).toHaveLength(60);
    expect(html).not.toContain("Search people");
    expect(html).not.toContain('type="search"');
    expect(html).not.toContain('role="radiogroup"');
  });
});

describe("search and Show (screens.md P5)", () => {
  const list = [
    person({ id: "1", name: "Chloé Rossi", email: "chloe.rossi@example.com" }),
    person({ id: "2", name: "Omar Haddad", email: "o.haddad@example.com", isAdministrator: true }),
    person({ id: "3", name: "Rosa Smit", email: "rosa@example.com", hasAccess: false, isAdministrator: true }),
  ];
  const ids = (q: string, show: "everyone" | "administrators" | "removed" = "everyone") => filterPeople(list, q, show).map((p) => p.id);
  it("matches any part of the name or the address, ignoring case and accents", () => {
    expect(ids("CHLOE")).toEqual(["1"]);
    expect(ids("chloé")).toEqual(["1"]);
    expect(ids("ros")).toEqual(["1", "3"]);
    expect(ids("o.haddad@")).toEqual(["2"]);
    expect(ids("  ")).toEqual(["1", "2", "3"]);
    expect(ids("zoltan")).toEqual([]);
  });
  it("Show combines with the search; a removed person is not an administrator", () => {
    expect(ids("", "administrators")).toEqual(["2"]);
    expect(ids("", "removed")).toEqual(["3"]);
    expect(ids("ros", "removed")).toEqual(["3"]);
    expect(peopleCounts(list)).toEqual({ all: 3, administrators: 1, removed: 1 });
  });
  it("SearchField: a visible label and description tied to an input that is never submitted by name", () => {
    const html = renderToStaticMarkup(<SearchField label="Search people" description="By name or email address." value="" onChange={() => {}} clearLabel="Clear" clearName="Clear search" />);
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Search people<\/label>/);
    expect(html).toMatch(/<input[^>]*aria-describedby="[^"]+"/);
    expect(html).not.toMatch(/<input[^>]* name=/);
    expect(html).toMatch(/autocomplete="off"/i);
  });
  it("ChoiceGroup: a labelled radio group, the chosen option checked", () => {
    const html = renderToStaticMarkup(
      <ChoiceGroup label="Show" value="b" onChange={() => {}} options={[{ value: "a", label: "Everyone (3)" }, { value: "b", label: "Administrators (1)" }]} />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="b"|<input[^>]*value="b"[^>]*checked=""/);
    expect(text(html)).toContain("Show Everyone (3) Administrators (1)");
  });
});

describe("record of actions (screens.md P14)", () => {
  it("one sentence per kind of action; an own withdrawal says so", () => {
    const by = { name: "Galem L.", email: "galem@example.com" };
    const about = { name: "Sanne Kok", email: "sanne.kok@example.com" };
    expect(recordSentence({ action: "access_removed", by, about })).toBe("Galem L. removed Sanne Kok's access.");
    expect(recordSentence({ action: "access_restored", by, about })).toBe("Galem L. restored Sanne Kok's access.");
    expect(recordSentence({ action: "administrator_made", by, about })).toBe("Galem L. made Sanne Kok an administrator.");
    expect(recordSentence({ action: "administrator_withdrawn", by, about })).toBe("Galem L. withdrew Sanne Kok's administrator role.");
    expect(recordSentence({ action: "administrator_withdrawn", by, about: by })).toBe("Galem L. withdrew their own administrator role.");
  });

  it("entries: read-only, each with its time and both addresses", () => {
    const html = renderToStaticMarkup(<ActionRecord entries={recordEntries} timeZone={storyTimeZone} />);
    expect(html).toContain('aria-label="Record of actions, newest first"');
    expect(html.match(/<li/g)).toHaveLength(recordEntries.length);
    expect(html).not.toMatch(/<button|<a |<input/);
    expect(html.match(/<time /g)).toHaveLength(recordEntries.length);
    const t = text(html);
    expect(t).toContain("By galem@example.com · about sanne.kok@example.com");
    expect(t).toContain("Tom Aubert withdrew their own administrator role.");
    expect(t).toMatch(/By tom\.aubert@example\.com(?! · about)/);
  });

  it("RecordScreen: same page title, the record marked current; empty, loading, error, offline", () => {
    const screen = (props: Partial<Parameters<typeof RecordScreen>[0]> = {}) =>
      renderToStaticMarkup(<RecordScreen email={principalEmail} entries={recordEntries} timeZone={storyTimeZone} {...props} />);
    const html = screen();
    expect(html).toMatch(/<h1[^>]*>People and access<\/h1>/);
    expect(html).toMatch(/<a [^>]*aria-current="page"[^>]*>Record of actions<\/a>/);
    expect(text(html)).toContain(`Showing ${recordEntries.length} of ${recordEntries.length} actions`);
    expect(text(screen({ entries: [] }))).toContain("No actions yet");
    expect(screen({ state: "loading", entries: [] })).toContain('aria-label="Loading the record"');
    expect(text(screen({ state: "error", entries: [], reference: "ref_1" }))).toContain("The record could not be loaded Nothing was changed. Reload the page to try again.");
    expect(text(screen({ state: "offline" }))).toContain("This record may be out of date.");
  });

  it("AdminNav: two links, the current one marked", () => {
    const html = renderToStaticMarkup(<AdminNav current="record" peopleHref="/admin/people" recordHref="/admin/record" />);
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toMatch(/<a [^>]*href="\/admin\/record"[^>]*aria-current="page"|<a [^>]*aria-current="page"[^>]*href="\/admin\/record"/);
  });
});

describe("words never used on these screens (screens.md §0)", () => {
  it("no identity-provider or access-control jargon in the new copy", () => {
    const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
    const all = strings([copy.orgSignIn, copy.accessRefused, copy.notAdministrator, copy.nav, copy.people, copy.record]);
    const banned = /\b(idp|identity provider|oidc|sso|provider|claim|token|session cookie|allow-?list|role-based|revoke[ds]?)\b/i;
    expect(all.filter((s) => banned.test(s))).toEqual([]);
    expect(all.filter((s) => /last (active|signed in|seen)|invite (a|some)/i.test(s))).toEqual([]);
  });
});
