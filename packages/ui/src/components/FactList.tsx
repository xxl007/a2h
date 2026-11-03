import type { ReactNode } from "react";
import styles from "./FactList.module.css";

export interface FactListProps {
  /** Accessible name of the list, usually the id of the heading above it. */
  "aria-labelledby"?: string;
  children: ReactNode;
}

/**
 * A description list of facts (skill §4a "kv"): term in --text-muted, value in --text.
 * Stacked under 600 px, a 150 px term column above.
 */
export function FactList({ children, "aria-labelledby": labelledBy }: FactListProps) {
  return (
    <dl className={styles.list} {...(labelledBy !== undefined ? { "aria-labelledby": labelledBy } : {})}>
      {children}
    </dl>
  );
}

export interface FactProps {
  term: string;
  children: ReactNode;
}

export function Fact({ term, children }: FactProps) {
  return (
    <div className={styles.row}>
      <dt className={styles.term}>{term}</dt>
      <dd className={styles.detail}>{children}</dd>
    </div>
  );
}

/** Secondary line inside a fact (terms, breakdown, notes): --text-muted, small. */
export function FactNote({ children }: { children: ReactNode }) {
  return <span className={styles.note}>{children}</span>;
}

/** Machine values in the mono role (handle, request id). */
export function Mono({ children }: { children: ReactNode }) {
  return <span className={styles.mono}>{children}</span>;
}

export interface OptionListProps {
  /** Labels verbatim, in the order the participant sees them. Ids are machine values and are not shown. */
  options: ReadonlyArray<{ id: string; label: string }>;
}

/** Poll options exactly as the participant will see them, numbered in order. */
export function OptionList({ options }: OptionListProps) {
  return (
    <ol className={styles.options}>
      {options.map((o) => (
        <li key={o.id}>{o.label}</li>
      ))}
    </ol>
  );
}
