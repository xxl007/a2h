import { Button, ButtonLink } from "../components/Button.js";
import { AuthShell, formActionProps } from "../components/AuthShell.js";
import { Notice } from "../components/Notice.js";
import type { FormAction } from "../components/types.js";
import { copy } from "./copy.js";
import styles from "./Screen.module.css";

export type CheckEmailState = "sent" | "resending" | "resent" | "error" | "offline";

export interface CheckEmailScreenProps {
  /** The address the person typed, from form state or a short-lived flash cookie; never from the URL. */
  email?: string;
  state?: CheckEmailState;
  /** Posts the same address (and `next`) to the magic-link request again. */
  resendAction?: FormAction;
  next?: string;
  /** Link back to the form, keeping `next`. */
  signInHref?: string;
  reference?: string;
  /** Non-production stages: the link goes to the mail sink, and the screen says so. */
  stageName?: string;
}

/** /sign-in/sent (design.md "Screen 2: Check your email"). Identical for known and unknown addresses. */
export function CheckEmailScreen({
  email,
  state = "sent",
  resendAction,
  next,
  signInHref = "/sign-in",
  reference,
  stageName,
}: CheckEmailScreenProps) {
  const c = copy.checkEmail;
  return (
    <AuthShell {...(stageName !== undefined ? { stageName } : {})}>
      <h1 className={styles.title}>{c.title}</h1>
      {stageName !== undefined && (
        <Notice tone="neutral" title={c.sinkTitle}>
          <p>{c.sinkBody}</p>
        </Notice>
      )}
      <div className={styles.stack}>
        <p className={styles.lead}>
          {email !== undefined ? (
            <>
              {c.sentTo.split("{address}")[0]}
              <span className={styles.strong}>{email}</span>
              {c.sentTo.split("{address}")[1]}
            </>
          ) : (
            c.sentToUnknown
          )}
        </p>
        <p className={styles.body}>{c.validity}</p>
        <p className={styles.muted}>{c.help}</p>
      </div>
      {state === "resent" && (
        <Notice tone="success" title={c.resentTitle} live="status">
          <p>{c.resentBody}</p>
        </Notice>
      )}
      {state === "error" && (
        <Notice tone="danger" title={c.errorTitle} live="alert" {...(reference !== undefined ? { reference } : {})}>
          <p>{c.errorBody}</p>
        </Notice>
      )}
      {state === "offline" && (
        <Notice tone="neutral" title={c.offlineTitle} live="status">
          <p>{c.offlineBody}</p>
        </Notice>
      )}
      <form className={styles.actions} method="post" {...formActionProps(resendAction)}>
        {email !== undefined && <input type="hidden" name="email" value={email} />}
        {next !== undefined && <input type="hidden" name="next" value={next} />}
        <Button type="submit" variant="ghost" isPending={state === "resending"} pendingLabel={c.resendPending}>
          {c.resend}
        </Button>
        <ButtonLink href={signInHref} variant="ghost">
          {c.otherAddress}
        </ButtonLink>
      </form>
    </AuthShell>
  );
}

export interface LinkExpiredScreenProps {
  /** /sign-in, keeping `next` when the link belonged to a connection. */
  signInHref?: string;
  stageName?: string;
}

/** /sign-in/expired: the magic link was expired or already used (spec "Expired or reused link"). */
export function LinkExpiredScreen({ signInHref = "/sign-in", stageName }: LinkExpiredScreenProps) {
  const c = copy.linkExpired;
  return (
    <AuthShell {...(stageName !== undefined ? { stageName } : {})}>
      <h1 className={styles.title}>{c.title}</h1>
      <p className={styles.lead}>{c.body}</p>
      <div className={styles.actions}>
        <ButtonLink href={signInHref} fullWidth>
          {c.action}
        </ButtonLink>
      </div>
    </AuthShell>
  );
}
