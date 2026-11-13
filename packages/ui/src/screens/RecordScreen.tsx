import { useEffect, useRef, useState } from "react";
import { ActionRecord } from "../components/ActionRecord.js";
import { AdminNav } from "../components/AdminNav.js";
import { AuthShell } from "../components/AuthShell.js";
import { Button, ButtonLink } from "../components/Button.js";
import type { NavLinkItem } from "../components/NavLinks.js";
import { Notice } from "../components/Notice.js";
import type { RecordEntry } from "../components/people.js";
import { Skeleton } from "../components/Skeleton.js";
import type { FormAction } from "../components/types.js";
import { useHydrated } from "../components/useSettled.js";
import { copy, fill } from "./copy.js";
import styles from "./Screen.module.css";

export type RecordState = "ready" | "loading" | "error" | "offline";
export const RECORD_PAGE = 50;

export interface RecordScreenProps {
  email: string;
  signOutAction?: FormAction;
  links?: readonly NavLinkItem[];
  stageName?: string;
  /** Every recorded action, newest first, each person with their current name and address. */
  entries: readonly RecordEntry[];
  state?: RecordState;
  reference?: string;
  reloadHref?: string;
  peopleHref?: string;
  recordHref?: string;
  /** Fixed zone, for stories and tests only. */
  timeZone?: string;
}

/** The record of administrator actions (screens.md P14): read-only, 50 at a time once the page is interactive. */
export function RecordScreen({
  email,
  signOutAction,
  links,
  stageName,
  entries,
  state = "ready",
  reference,
  reloadHref = "/admin/record",
  peopleHref = "/admin/people",
  recordHref = "/admin/record",
  timeZone,
}: RecordScreenProps) {
  const c = copy.record;
  const hydrated = useHydrated();
  const [shown, setShown] = useState(RECORD_PAGE);
  const [focusId, setFocusId] = useState<string | undefined>();
  const listRef = useRef<HTMLDivElement>(null);
  const visible = hydrated ? entries.slice(0, shown) : entries;
  const step = Math.min(RECORD_PAGE, entries.length - visible.length);
  const listed = state === "ready" || state === "offline";

  useEffect(() => {
    if (focusId === undefined) return;
    listRef.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(focusId)}"]`)?.focus();
  }, [focusId]);

  return (
    <AuthShell
      width="wide"
      account={{ email, ...(signOutAction !== undefined ? { signOutAction } : {}) }}
      {...(links !== undefined ? { links } : {})}
      {...(stageName !== undefined ? { stageName } : {})}
    >
      <h1 className={styles.title}>{copy.people.title}</h1>
      <AdminNav current="record" peopleHref={peopleHref} recordHref={recordHref} />
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
              <Skeleton height={20} width="70%" />
              <Skeleton height={16} width="45%" />
              <Skeleton height={16} width="60%" />
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
              {copy.people.reload}
            </ButtonLink>
          </div>
        </>
      )}
      {listed && entries.length === 0 && (
        <Notice tone="neutral" title={c.emptyTitle}>
          <p>{c.emptyBody}</p>
        </Notice>
      )}
      {listed && entries.length > 0 && (
        <>
          <div ref={listRef}>
            <ActionRecord entries={visible} {...(timeZone !== undefined ? { timeZone } : {})} />
          </div>
          <div className={styles.more}>
            <p className={styles.count} role="status">
              {fill(c.showing, {
                shown: String(visible.length),
                total: String(entries.length),
                actions: entries.length === 1 ? c.action.one : c.action.other,
              })}
            </p>
            {step > 0 && (
              <Button
                variant="ghost"
                onPress={() => {
                  const first = entries[shown];
                  setShown(shown + step);
                  if (first !== undefined) setFocusId(first.id);
                }}
              >
                {fill(c.older, { n: String(step) })}
              </Button>
            )}
          </div>
        </>
      )}
    </AuthShell>
  );
}
