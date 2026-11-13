import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { copy, fill } from "../screens/copy.js";
import { Button, TextLink } from "./Button.js";
import { fillNodes } from "./fillNodes.js";
import { Notice } from "./Notice.js";
import { isActiveAdministrator, personOffers, type Person, type PersonAction, type PersonRefusal } from "./people.js";
import { StatusPill } from "./StatusPill.js";
import styles from "./PersonRow.module.css";

export type PersonRowStatus = { kind: "idle" } | { kind: "confirming" | "pending"; action: PersonAction };

export type PersonRowNotice =
  | { kind: "done"; action: PersonAction; /** The person was an administrator when their access was removed. */ wasAdministrator?: boolean }
  | { kind: "already-done" }
  | { kind: "refused"; action: PersonAction; refusal: PersonRefusal }
  | { kind: "failed"; action: PersonAction; reference?: string };

/** Where focus goes after a change; a new `key` asks again. "access" and "role" are the row's two buttons. */
export interface PersonRowFocus {
  target: "confirm" | "name" | "notice" | "access" | "role";
  key: number;
}

export interface PersonRowProps {
  person: Person;
  /** The viewer is the only administrator with access (their own role cannot be withdrawn). */
  onlyAdministrator: boolean;
  status?: PersonRowStatus;
  notice?: PersonRowNotice;
  focus?: PersonRowFocus;
  recordHref?: string;
  onOpen?: (action: PersonAction) => void;
  onCancel?: () => void;
  onConfirm?: (action: PersonAction) => void;
}

const idle: PersonRowStatus = { kind: "idle" };

/** The confirmation's words for an action on this person (screens.md P6–P10). */
export function confirmationCopy(person: Person, action: PersonAction) {
  const c = copy.people.confirm;
  if (action === "withdraw" && person.isYou) return c.withdrawOwn;
  const words = c[action];
  const question = fill(words.question, { name: person.name });
  if (action === "remove" && isActiveAdministrator(person)) return { ...words, question, body: c.remove.bodyAdministrator };
  if (action === "restore" && person.administratorOnRestore) return { ...words, question, body: c.restore.bodyAdministrator };
  return { ...words, question };
}

function noticeContent(person: Person, notice: PersonRowNotice, recordHref: string): { tone: "success" | "neutral" | "danger"; title: string; body: ReactNode; reference?: string } {
  const c = copy.people;
  const name = { name: person.name };
  if (notice.kind === "already-done") return { tone: "neutral", title: c.done.alreadyTitle, body: c.done.alreadyBody };
  if (notice.kind === "done") {
    const words = c.done[notice.action];
    const body = notice.action === "remove" && notice.wasAdministrator ? c.done.remove.bodyAdministrator : words.body;
    const record = fillNodes(c.done.inRecord, { record: <TextLink href={recordHref}>{c.done.recordLink}</TextLink> });
    return { tone: "success", title: fill(words.title, name), body: <>{body} {record}</> };
  }
  if (notice.kind === "failed") {
    const words = c.failed[notice.action];
    const title = notice.action === "withdraw" && person.isYou ? c.failed.withdrawTitleYou : fill(words.title, name);
    return { tone: "danger", title, body: fill(c.failed.body, { what: words.what }), ...(notice.reference !== undefined ? { reference: notice.reference } : {}) };
  }
  const r = c.refused;
  if (notice.refusal === "own_access") return { tone: "danger", title: r.ownAccessTitle, body: r.ownAccessBody };
  if (notice.refusal === "named_in_configuration")
    return person.isYou
      ? { tone: "danger", title: r.configuredTitleYou, body: r.configuredBodyYou }
      : { tone: "danger", title: fill(r.configuredTitle, name), body: r.configuredBody };
  if (notice.action === "remove") return { tone: "danger", title: fill(r.lastRemoveTitle, name), body: r.lastRemoveBody };
  return person.isYou
    ? { tone: "danger", title: r.lastWithdrawTitleYou, body: r.lastWithdrawBodyYou }
    : { tone: "danger", title: fill(r.lastWithdrawTitle, name), body: r.lastWithdrawBody };
}

/**
 * One person on the administrators' page: name, address, state in words, up to two actions or the
 * reason an action is not offered, and an inline confirmation (the ClientRow pattern; no dialog, no
 * focus trap). The row stays after the action and says what happened. A person's name and address
 * are plain text: no accent, no tint (ADR 0003).
 */
export function PersonRow({
  person,
  onlyAdministrator,
  status = idle,
  notice,
  focus,
  recordHref = "/admin/record",
  onOpen,
  onCancel,
  onConfirm,
}: PersonRowProps) {
  const c = copy.people;
  const rowRef = useRef<HTMLLIElement>(null);
  const questionId = useId();
  const offers = personOffers(person, onlyAdministrator);
  const who = fill(c.who, { name: person.name, email: person.email });
  const open = status.kind !== "idle";
  const pending = status.kind === "pending";

  const focusKey = focus?.key;
  const focusTarget = focus?.target;
  useEffect(() => {
    if (focusKey === undefined || focusTarget === undefined) return;
    const row = rowRef.current;
    const target =
      row?.querySelector<HTMLElement>(`[data-focus-target="${focusTarget}"]`) ??
      row?.querySelector<HTMLElement>(`[data-focus-target-wrap="${focusTarget}"] :is(button, [tabindex])`) ??
      row?.querySelector<HTMLElement>('[data-focus-target="name"]');
    target?.focus();
  }, [focusKey, focusTarget]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && status.kind === "confirming") onCancel?.();
  };

  const trigger = (action: PersonAction, slot: "access" | "role") => (
    <span data-focus-target-wrap={slot} className={styles.trigger}>
      <Button variant="ghost" aria-label={fill(c.actions[action].name, { who })} onPress={() => onOpen?.(action)}>
        {c.actions[action].label}
      </Button>
    </span>
  );

  const words = open ? confirmationCopy(person, status.action) : undefined;
  const said = notice !== undefined && !open ? noticeContent(person, notice, recordHref) : undefined;

  return (
    <li className={styles.row} ref={rowRef}>
      <div className={styles.summary}>
        <div className={styles.who}>
          <h2 className={styles.name} tabIndex={-1} data-focus-target="name">
            {person.name}
            {person.isYou && <span className={styles.you}> {c.you}</span>}
          </h2>
          <p className={styles.email}>{person.email}</p>
          <p className={styles.states}>
            <StatusPill tone={person.hasAccess ? "success" : "neutral"}>{person.hasAccess ? c.pillAccess : c.pillRemoved}</StatusPill>
            {isActiveAdministrator(person) && <> <StatusPill tone="neutral">{c.pillAdministrator}</StatusPill></>}
          </p>
        </div>
        {!open && (offers.access !== undefined || offers.role !== undefined) && (
          <div className={styles.actions}>
            {offers.access !== undefined && trigger(offers.access, "access")}
            {offers.role !== undefined && trigger(offers.role, "role")}
          </div>
        )}
      </div>
      {offers.reasons.map((reason) => (
        <p key={reason} className={styles.reason}>
          {reason}
        </p>
      ))}
      {said !== undefined && (
        <div data-focus-target-wrap="notice">
          <Notice
            tone={said.tone}
            title={said.title}
            live={said.tone === "danger" ? "alert" : "status"}
            focusable={said.tone === "danger"}
            {...(said.reference !== undefined ? { reference: said.reference } : {})}
          >
            <p>{said.body}</p>
          </Notice>
        </div>
      )}
      {open && words !== undefined && (
        <div className={styles.confirm} role="group" aria-labelledby={questionId} tabIndex={-1} data-focus-target="confirm" onKeyDown={onKeyDown}>
          <p id={questionId} className={styles.question}>
            {words.question}
          </p>
          <p className={styles.body}>{words.body}</p>
          <div className={styles.buttons}>
            <Button isPending={pending} pendingLabel={words.pending} onPress={() => onConfirm?.(status.action)}>
              {words.yes}
            </Button>
            <Button variant="ghost" isDisabled={pending} onPress={() => onCancel?.()}>
              {words.no}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
