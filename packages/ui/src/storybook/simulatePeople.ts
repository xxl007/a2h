import { useRef, useState } from "react";
import { isActiveAdministrator, type Person, type PersonActionResult } from "../components/people.js";

export interface SimulatedPeople {
  people: readonly Person[];
  onRemoveAccess: (id: string) => Promise<PersonActionResult>;
  onRestoreAccess: (id: string) => Promise<PersonActionResult>;
  onMakeAdministrator: (id: string) => Promise<PersonActionResult>;
  onWithdrawAdministrator: (id: string) => Promise<PersonActionResult>;
}

/**
 * Storybook only: stands in for the server actions of the administrators' page, with the rules of
 * design.md D7 (own access, last administrator, named in the configuration; the administrator flag
 * is kept while access is removed). `server` is what the server holds when it differs from what the
 * page was given (an out-of-date page); `fail` makes every action reject, as when it does not go through.
 */
export function useSimulatedPeople(shown: readonly Person[], options: { server?: readonly Person[]; fail?: boolean; delay?: number } = {}): SimulatedPeople {
  const [people, setPeople] = useState(shown);
  const server = useRef(options.server ?? shown);
  const act = (id: string, change: (person: Person, all: readonly Person[]) => Person | PersonActionResult) =>
    new Promise<PersonActionResult>((resolve, reject) => {
      setTimeout(() => {
        if (options.fail) {
          reject(Object.assign(new Error("simulated"), { reference: "ref_51d0c7e2a48b4c39" }));
          return;
        }
        const all = server.current;
        const person = all.find((p) => p.id === id);
        if (person === undefined) {
          reject(new Error("unknown person"));
          return;
        }
        const changed = change(person, all);
        if ("ok" in changed) {
          setPeople(changed.people);
          resolve(changed);
          return;
        }
        server.current = all.map((p) => (p.id === id ? changed : p));
        setPeople(server.current);
        resolve({ ok: true, people: server.current });
      }, options.delay ?? 600);
    });
  const lastAdministrator = (person: Person, all: readonly Person[]) => isActiveAdministrator(person) && all.filter(isActiveAdministrator).length === 1;
  return {
    people,
    onRemoveAccess: (id) =>
      act(id, (p, all) => {
        if (p.isYou) return { ok: false, refusal: "own_access", people: all };
        if (lastAdministrator(p, all)) return { ok: false, refusal: "last_administrator", people: all };
        if (!p.hasAccess) return { ok: true, alreadyDone: true, people: all };
        return { ...p, hasAccess: false, administratorOnRestore: p.isAdministrator || p.namedInConfiguration };
      }),
    onRestoreAccess: (id) =>
      act(id, (p, all) => (p.hasAccess ? { ok: true, alreadyDone: true, people: all } : { ...p, hasAccess: true, isAdministrator: p.administratorOnRestore, administratorOnRestore: false })),
    onMakeAdministrator: (id) => act(id, (p, all) => (p.isAdministrator ? { ok: true, alreadyDone: true, people: all } : { ...p, isAdministrator: true })),
    onWithdrawAdministrator: (id) =>
      act(id, (p, all) => {
        if (p.namedInConfiguration) return { ok: false, refusal: "named_in_configuration", people: all };
        if (lastAdministrator(p, all)) return { ok: false, refusal: "last_administrator", people: all };
        if (!p.isAdministrator) return { ok: true, alreadyDone: true, people: all };
        return { ...p, isAdministrator: false };
      }),
  };
}
