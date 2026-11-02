import type { ReactNode } from "react";
import styles from "./Notice.module.css";

/**
 * danger, pending, success, neutral: status triplets (skill §3.2), always with words.
 * platform: an A2H note (card.platform); its title takes the accent.
 */
export type NoticeTone = "danger" | "pending" | "success" | "neutral" | "platform";

export interface NoticeProps {
  tone: NoticeTone;
  /** The status in words. Required: colour is never the only signal. */
  title: string;
  children?: ReactNode;
  /** Request id for support, in the mono role. Never an error code, token or stack. */
  reference?: string;
  /**
   * "alert" for errors that follow a user action, "status" for confirmations,
   * "none" for notices present on page load (read in document order).
   */
  live?: "alert" | "status" | "none";
  id?: string;
  /** Lets a screen move focus to the notice after an action (tabIndex -1). */
  focusable?: boolean;
}

export function Notice({ tone, title, children, reference, live = "none", id, focusable = false }: NoticeProps) {
  const role = live === "none" ? undefined : live;
  return (
    <div
      className={`${styles.notice} ${styles[tone]}`}
      {...(role ? { role } : {})}
      {...(id !== undefined ? { id } : {})}
      {...(focusable ? { tabIndex: -1 } : {})}
    >
      <p className={styles.title}>{title}</p>
      {children}
      {reference !== undefined && <span className={styles.reference}>Reference {reference}</span>}
    </div>
  );
}
