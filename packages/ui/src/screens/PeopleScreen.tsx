import { useEffect, useMemo, useRef, useState } from "react";
import { AdminNav } from "../components/AdminNav.js";
import { AuthShell } from "../components/AuthShell.js";
import { Button, ButtonLink } from "../components/Button.js";
import { ChoiceGroup } from "../components/ChoiceGroup.js";
import type { NavLinkItem } from "../components/NavLinks.js";
import { Notice } from "../components/Notice.js";
import {
  countLine,
  countPeople,
  filterPeople,
  isActiveAdministrator,
  peopleCounts,
  type PeopleShow,
  type Person,
  type PersonAction,
  type PersonActionResult,
} from "../components/people.js";
import { PersonRow, type PersonRowFocus, type PersonRowNotice, type PersonRowStatus } from "../components/PersonRow.js";
import { SearchField } from "../components/SearchField.js";
import { Skeleton } from "../components/Skeleton.js";
import type { FormAction } from "../components/types.js";
import { useHydrated, useSettled } from "../components/useSettled.js";
import { copy, fill } from "./copy.js";
import styles from "./Screen.module.css";

export type PeopleState = "ready" | "loading" | "error" | "offline";
export type PersonActionHandler = (id: string) => Promise<PersonActionResult>;

/** The list is short enough to read up to this many people; above it, search and "Show" appear. */
export const PEOPLE_TOOLS_ABOVE = 10;
export const PEOPLE_PAGE = 50;

export interface PeopleScreenProps {
  /** The signed-in administrator's own address, for the header. */
  email: string;
  signOutAction?: FormAction;
  /** Header links: "Connected apps" and "People and access" (current). */
  links?: readonly NavLinkItem[];
  stageName?: string;
  /** Everyone who has signed in, sorted by name. The whole list (designed for up to 1,000 people). */
  people: readonly Person[];
  state?: PeopleState;
  /** Request id for the "could not be loaded" notice. */
  reference?: string;
  reloadHref?: string;
  peopleHref?: string;
  recordHref?: string;
  /**
   * The four actions. Each resolves with the server's answer and the refreshed list, and rejects when
   * it did not go through; a rejection that carries a string `reference` shows it in the notice.
   * After withdrawing one's own role the app leaves the page; the row stays busy until it does.
   */
  onRemoveAccess?: PersonActionHandler;
  onRestoreAccess?: PersonActionHandler;
  onMakeAdministrator?: PersonActionHandler;
  onWithdrawAdministrator?: PersonActionHandler;
  /** Storybook and tests only: open one row in a given state, or start with a search or a "Show" choice. */
  initial?: { id?: string; status?: PersonRowStatus; notice?: PersonRowNotice; query?: string; show?: PeopleShow };
}

const referenceOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "reference" in error && typeof error.reference === "string" ? error.reference : undefined;

/**
 * The administrators' page (screens.md P1–P13). It shows names, addresses, access and role, and
 * nothing else about anyone. Search and "Show" run in the browser on the list it was given: the
 * search text is never put in a URL, a form or a request.
 */
export function PeopleScreen({
  email,
  signOutAction,
  links,
  stageName,
  people,
  state = "ready",
  reference,
  reloadHref = "/admin/people",
  peopleHref = "/admin/people",
  recordHref = "/admin/record",
  onRemoveAccess,
  onRestoreAccess,
  onMakeAdministrator,
  onWithdrawAdministrator,
  initial,
}: PeopleScreenProps) {
  const c = copy.people;
  const hydrated = useHydrated();
  const [list, setList] = useState(people);
  useEffect(() => setList(people), [people]);

  const [open, setOpen] = useState<{ id: string; status: PersonRowStatus } | undefined>(
    initial?.id !== undefined && initial.status !== undefined ? { id: initial.id, status: initial.status } : undefined,
  );
  const [notices, setNotices] = useState<Record<string, PersonRowNotice>>(
    initial?.id !== undefined && initial.notice !== undefined ? { [initial.id]: initial.notice } : {},
  );
  const [pinned, setPinned] = useState<readonly string[]>([]);
  const [focus, setFocus] = useState<({ id: string } & PersonRowFocus) | undefined>();
  const [query, setQuery] = useState(initial?.query ?? "");
  const [show, setShow] = useState<PeopleShow>(initial?.show ?? "everyone");
  const [shown, setShown] = useState(PEOPLE_PAGE);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusKey = useRef(0);
  const focusOn = (id: string, target: PersonRowFocus["target"]) => setFocus({ id, target, key: ++focusKey.current });

  // Sorted in the viewer's locale once the page is interactive; before that, in the order given.
  const sorted = useMemo(() => (hydrated ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : list), [list, hydrated]);
  const counts = peopleCounts(list);
  const onlyAdministrator = counts.administrators === 1;
  const onlyYou = list.length === 1 && list[0]?.isYou === true;
  const tools = hydrated && list.length > PEOPLE_TOOLS_ABOVE;
  const text = query.trim();
  const matching = useMemo(() => {
    if (!tools) return sorted;
    const hits = new Set(filterPeople(sorted, query, show).map((p) => p.id));
    return sorted.filter((p) => hits.has(p.id) || pinned.includes(p.id) || open?.id === p.id);
  }, [tools, sorted, query, show, pinned, open?.id]);
  const visible = tools ? matching.slice(0, shown) : sorted;
  const showing = fill(text === "" ? c.showing : c.showingMatching, { shown: String(visible.length), total: countPeople(matching.length), text });
  const settledShowing = useSettled(showing);
  const settledText = useSettled(text);
  const noMatch = tools && matching.length === 0 && text !== "";
  const step = Math.min(PEOPLE_PAGE, matching.length - shown);

  const refine = (change: () => void) => {
    change();
    setShown(PEOPLE_PAGE);
    setPinned([]);
  };

  const openConfirmation = (id: string, action: PersonAction) => {
    setOpen({ id, status: { kind: "confirming", action } });
    setNotices((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== id)));
    focusOn(id, "confirm");
  };
  const cancel = (id: string, action: PersonAction) => {
    setOpen(undefined);
    focusOn(id, action === "remove" || action === "restore" ? "access" : "role");
  };
  const confirm = async (id: string, action: PersonAction) => {
    const person = list.find((p) => p.id === id);
    const handler = { remove: onRemoveAccess, restore: onRestoreAccess, grant: onMakeAdministrator, withdraw: onWithdrawAdministrator }[action];
    if (person === undefined || handler === undefined) {
      setOpen(undefined);
      return;
    }
    setOpen({ id, status: { kind: "pending", action } });
    const say = (notice: PersonRowNotice, target: PersonRowFocus["target"]) => {
      setNotices((all) => ({ ...all, [id]: notice }));
      setPinned((ids) => [...ids, id]);
      setOpen(undefined);
      focusOn(id, target);
    };
    try {
      const result = await handler(id);
      setList(result.people);
      if (!result.ok) say({ kind: "refused", action, refusal: result.refusal }, "notice");
      else if (result.alreadyDone) say({ kind: "already-done" }, "name");
      else if (action === "withdraw" && person.isYou) return; // the app leaves the page; the button stays busy
      else say({ kind: "done", action, wasAdministrator: isActiveAdministrator(person) }, "name");
    } catch (error) {
      const ref = referenceOf(error);
      say({ kind: "failed", action, ...(ref !== undefined ? { reference: ref } : {}) }, "notice");
    }
  };

  const listed = state === "ready" || state === "offline";
  return (
    <AuthShell
      width="wide"
      account={{ email, ...(signOutAction !== undefined ? { signOutAction } : {}) }}
      {...(links !== undefined ? { links } : {})}
      {...(stageName !== undefined ? { stageName } : {})}
    >
      <h1 className={styles.title}>{c.title}</h1>
      <AdminNav current="people" peopleHref={peopleHref} recordHref={recordHref} />
      <p className={styles.lead}>{c.lead}</p>
      <p className={styles.muted}>{c.note}</p>
      {state === "offline" && (
        <Notice tone="neutral" title={c.offlineTitle} live="status">
          <p>{c.offlineBody}</p>
        </Notice>
      )}
      {state === "loading" && (
        <div aria-busy="true" role="status" aria-label={c.loading} className={styles.stack}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={styles.tight}>
              <Skeleton height={20} width="40%" />
              <Skeleton height={16} width="55%" />
              <Skeleton height={20} width="30%" />
            </div>
          ))}
        </div>
      )}
      {state === "error" && (
        <>
          <Notice tone="danger" title={c.errorTitle} live="alert" {...(reference !== undefined ? { reference } : {})}>
            <p>{c.errorBody}</p>
          </Notice>
          <div className={styles.actions}>
            <ButtonLink href={reloadHref} variant="ghost">
              {c.reload}
            </ButtonLink>
          </div>
        </>
      )}
      {listed && tools && (
        <div className={styles.tools}>
          <SearchField
            label={c.searchLabel}
            description={c.searchDescription}
            value={query}
            onChange={(value) => refine(() => setQuery(value))}
            clearLabel={c.searchClear}
            clearName={c.searchClearName}
            inputRef={searchRef}
          />
          <ChoiceGroup<PeopleShow>
            label={c.show}
            value={show}
            onChange={(value) => refine(() => setShow(value))}
            options={[
              { value: "everyone", label: fill(c.showEveryone, { n: String(counts.all) }) },
              { value: "administrators", label: fill(c.showAdministrators, { n: String(counts.administrators) }) },
              { value: "removed", label: fill(c.showRemoved, { n: String(counts.removed) }) },
            ]}
          />
        </div>
      )}
      {listed && !tools && !onlyYou && list.length > 0 && (
        <p className={styles.count} role="status">
          {countLine(list)}
        </p>
      )}
      {listed && visible.length > 0 && (
        <ul className={styles.list} aria-label={c.listLabel}>
          {visible.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              onlyAdministrator={onlyAdministrator}
              recordHref={recordHref}
              {...(open?.id === person.id ? { status: open.status } : {})}
              {...(notices[person.id] !== undefined ? { notice: notices[person.id] } : {})}
              {...(focus?.id === person.id ? { focus: { target: focus.target, key: focus.key } } : {})}
              onOpen={(action) => openConfirmation(person.id, action)}
              onCancel={() => open?.id === person.id && open.status.kind !== "idle" && cancel(person.id, open.status.action)}
              onConfirm={(action) => void confirm(person.id, action)}
            />
          ))}
        </ul>
      )}
      {listed && onlyYou && (
        <Notice tone="neutral" title={c.onlyYouTitle}>
          <p>{c.onlyYouBody}</p>
        </Notice>
      )}
      {listed && noMatch && settledText === text && (
        <>
          <Notice tone="neutral" title={fill(c.noMatchTitle, { text })} live="status">
            <p>{c.noMatchBody}</p>
          </Notice>
          <div className={styles.start}>
            <Button
              variant="ghost"
              onPress={() => {
                refine(() => setQuery(""));
                searchRef.current?.focus();
              }}
            >
              {c.clearSearch}
            </Button>
          </div>
        </>
      )}
      {listed && tools && !noMatch && (
        <div className={styles.more}>
          <p className={styles.count} role="status">
            {settledShowing}
          </p>
          {step > 0 && (
            <Button
              variant="ghost"
              onPress={() => {
                const first = matching[shown];
                setShown(shown + step);
                if (first !== undefined) focusOn(first.id, "name");
              }}
            >
              {fill(c.more, { n: String(step) })}
            </Button>
          )}
        </div>
      )}
    </AuthShell>
  );
}
