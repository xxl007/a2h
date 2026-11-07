import styles from "./StatusPill.module.css";

export type StatusPillTone = "success" | "pending" | "danger" | "neutral";

export interface StatusPillProps {
  tone: StatusPillTone;
  /** The status in words; a pill is never colour alone (skill §3.2). */
  children: string;
}

/** Sentence-case status pill on a status triplet. */
export function StatusPill({ tone, children }: StatusPillProps) {
  return <span className={`${styles.pill} ${styles[tone]}`}>{children}</span>;
}
