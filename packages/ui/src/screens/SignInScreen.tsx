import { Button } from "../components/Button.js";
import { AuthShell, formActionProps } from "../components/AuthShell.js";
import { Notice } from "../components/Notice.js";
import { TextField } from "../components/TextField.js";
import type { FormAction } from "../components/types.js";
import { copy } from "./copy.js";
import styles from "./Screen.module.css";

export type SignInState = "idle" | "submitting" | "invalid" | "error" | "rate-limited" | "offline";

export interface SignInScreenProps {
  /** Posts `email` (and the hidden `next`) to the magic-link request. */
  action?: FormAction;
  state?: SignInState;
  /** The address the person typed, kept after an error or offline attempt. Never put in the URL. */
  email?: string;
  /** Present when sign-in was started by an agent's connection request (the authorize URL to return to). */
  next?: string;
  /** Request id for the error notice. */
  reference?: string;
  /** "empty" or "format" for the invalid state. */
  invalidReason?: "empty" | "format";
  stageName?: string;
}

/** /sign-in (design.md "Screen 1: Sign in"). */
export function SignInScreen({
  action,
  state = "idle",
  email,
  next,
  reference,
  invalidReason = "format",
  stageName,
}: SignInScreenProps) {
  const c = copy.signIn;
  const connecting = next !== undefined;
  return (
    <AuthShell {...(stageName !== undefined ? { stageName } : {})}>
      <h1 className={styles.title}>{c.title}</h1>
      <p className={styles.lead}>{connecting ? c.leadConnecting : c.lead}</p>
      {state === "error" && (
        <Notice tone="danger" title={c.errorTitle} live="alert" {...(reference !== undefined ? { reference } : {})}>
          <p>{c.errorBody}</p>
        </Notice>
      )}
      {state === "rate-limited" && (
        <Notice tone="danger" title={c.rateLimitedTitle} live="alert">
          <p>{c.rateLimitedBody}</p>
        </Notice>
      )}
      {state === "offline" && (
        <Notice tone="neutral" title={c.offlineTitle} live="status">
          <p>{c.offlineBody}</p>
        </Notice>
      )}
      <form className={styles.form} method="post" noValidate {...formActionProps(action)}>
        {next !== undefined && <input type="hidden" name="next" value={next} />}
        <TextField
          label={c.emailLabel}
          name="email"
          type="email"
          autoComplete="email"
          isRequired
          autoFocus={state === "invalid"}
          {...(email !== undefined ? { defaultValue: email } : {})}
          {...(state === "invalid" ? { errorMessage: invalidReason === "empty" ? c.errorEmpty : c.errorFormat } : {})}
        />
        <Button type="submit" fullWidth isPending={state === "submitting"} pendingLabel={c.submitPending}>
          {c.submit}
        </Button>
      </form>
      <p className={styles.muted}>{c.footnote}</p>
    </AuthShell>
  );
}
