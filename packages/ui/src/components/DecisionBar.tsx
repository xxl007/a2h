import type { ReactNode } from "react";
import { Button } from "./Button.js";
import styles from "./DecisionBar.module.css";

export interface DecisionBarProps {
  /** "Send · hold €35.00" on a paid lane, "Send" on a free lane: the consequence is on the button. */
  sendLabel: string;
  sendPendingLabel: string;
  dontSendLabel: string;
  dontSendPendingLabel: string;
  /** Which decision is being recorded; the other button is disabled meanwhile. */
  pending?: "send" | "dont-send";
  /** Send unavailable (blank question, over the limit). "Don't send" is always available. */
  sendDisabled?: boolean;
  /** Id of the text that says why Send is unavailable. */
  sendDescribedBy?: string;
  /** One muted line under the buttons (nothing moves until you choose, link validity). */
  note?: ReactNode;
  /** Why Send is unavailable because of the files, stated next to it (m2-attachments F6, F7). */
  reason?: string;
  /** Id for `reason`, so Send can point at it with `sendDescribedBy`. */
  reasonId?: string;
}

/**
 * Exactly two decisions, neither pre-selected, neither the form's default (spec "Two actions,
 * money on the send action"). Both are submit buttons named `decision` so the page works with
 * JavaScript off; the form holds no single-line input, so Enter never submits implicitly.
 */
export function DecisionBar({
  sendLabel,
  sendPendingLabel,
  dontSendLabel,
  dontSendPendingLabel,
  pending,
  sendDisabled = false,
  sendDescribedBy,
  note,
  reason,
  reasonId,
}: DecisionBarProps) {
  return (
    <div className={styles.bar}>
      {reason !== undefined && (
        <p className={styles.reason} {...(reasonId !== undefined ? { id: reasonId } : {})}>
          {reason}
        </p>
      )}
      <div className={styles.buttons}>
        <Button
          type="submit"
          name="decision"
          value="send"
          isPending={pending === "send"}
          pendingLabel={sendPendingLabel}
          isDisabled={sendDisabled || pending === "dont-send"}
          {...(sendDescribedBy !== undefined ? { "aria-describedby": sendDescribedBy } : {})}
        >
          {sendLabel}
        </Button>
        <Button
          type="submit"
          variant="ghost"
          name="decision"
          value="dont_send"
          isPending={pending === "dont-send"}
          pendingLabel={dontSendPendingLabel}
          isDisabled={pending === "send"}
        >
          {dontSendLabel}
        </Button>
      </div>
      {note !== undefined && <p className={styles.note}>{note}</p>}
    </div>
  );
}
