import { copy, fill } from "../screens/copy.js";

/**
 * One person on the administrators' page. Deliberately no "last active", "last signed in", request,
 * answer or rules field: the page cannot show what it is never given (screens.md "Props for the web dev").
 */
export interface Person {
  id: string;
  /** The name the organisation's sign-in gave; the address when it gave none. */
  name: string;
  email: string;
  hasAccess: boolean;
  isAdministrator: boolean;
  isYou: boolean;
  /** Administrators only: named in the install's configuration, so the role cannot be withdrawn here. */
  namedInConfiguration: boolean;
  /** Access removed, and named in the configuration or still flagged: an administrator again if restored. */
  administratorOnRestore: boolean;
}

export type PersonAction = "remove" | "restore" | "grant" | "withdraw";
export type PersonRefusal = "own_access" | "last_administrator" | "named_in_configuration";

/** What the server answers to an action. It always sends the whole list back. */
export type PersonActionResult =
  | { ok: true; people: readonly Person[]; /** Another administrator had already done it (neutral "Already done"). */ alreadyDone?: boolean }
  | { ok: false; refusal: PersonRefusal; people: readonly Person[] };

export type PeopleShow = "everyone" | "administrators" | "removed";

/** An administrator is someone with access who has the role; a removed person is not one meanwhile. */
export const isActiveAdministrator = (person: Person): boolean => person.hasAccess && person.isAdministrator;

export interface PersonOffers {
  access: "remove" | "restore" | undefined;
  role: "grant" | "withdraw" | undefined;
  /** Why an action is not offered, said in place of a disabled button. */
  reasons: readonly string[];
}

/** The table of screens.md P1: which actions a row offers and what it says in place of one it does not. */
export function personOffers(person: Person, onlyAdministrator: boolean): PersonOffers {
  const r = copy.people.reasons;
  const reasons: string[] = [];
  let access: PersonOffers["access"];
  let role: PersonOffers["role"];
  if (person.isYou) reasons.push(r.ownAccess);
  else access = person.hasAccess ? "remove" : "restore";
  if (!person.hasAccess) {
    if (person.administratorOnRestore) reasons.push(r.removedAdministrator);
  } else if (!person.isAdministrator) role = "grant";
  else if (person.namedInConfiguration) reasons.push(person.isYou ? r.configuredYou : r.configured);
  else if (person.isYou && onlyAdministrator) reasons.push(r.onlyAdministrator);
  else role = "withdraw";
  return { access, role, reasons };
}

export function peopleCounts(people: readonly Person[]): { all: number; administrators: number; removed: number } {
  return {
    all: people.length,
    administrators: people.filter(isActiveAdministrator).length,
    removed: people.filter((p) => !p.hasAccess).length,
  };
}

const plain = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Search by any part of the name or the address, case and accents ignored, combined with "Show". Runs in the browser only. */
export function filterPeople(people: readonly Person[], query: string, show: PeopleShow): Person[] {
  const q = plain(query.trim());
  return people.filter((p) => {
    if (show === "administrators" && !isActiveAdministrator(p)) return false;
    if (show === "removed" && p.hasAccess) return false;
    return q === "" || plain(p.name).includes(q) || plain(p.email).includes(q);
  });
}

export const countPeople = (n: number): string => (n === 1 ? copy.people.person.one : fill(copy.people.person.other, { n: String(n) }));
export const countAdministrators = (n: number): string =>
  n === 1 ? copy.people.administrator.one : fill(copy.people.administrator.other, { n: String(n) });

/** "6 people · 2 administrators · 1 with access removed". */
export function countLine(people: readonly Person[]): string {
  const counts = peopleCounts(people);
  return fill(copy.people.counts, {
    people: countPeople(counts.all),
    administrators: countAdministrators(counts.administrators),
    removed: String(counts.removed),
  });
}

export type RecordAction = "access_removed" | "access_restored" | "administrator_made" | "administrator_withdrawn";

export interface RecordEntry {
  id: string;
  action: RecordAction;
  /** Current name and address, joined from the account. */
  by: { name: string; email: string };
  about: { name: string; email: string };
  /** ISO 8601 date-time. */
  at: string;
}

/** "Galem L. removed Sanne Kok's access." An administrator withdrawing their own role is said as such. */
export function recordSentence(entry: Pick<RecordEntry, "action" | "by" | "about">): string {
  const s = copy.record.sentences;
  const own = entry.action === "administrator_withdrawn" && entry.by.email === entry.about.email;
  return fill(own ? s.administrator_withdrawn_own : s[entry.action], { by: entry.by.name, about: entry.about.name });
}
