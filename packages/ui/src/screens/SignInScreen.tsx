import { Button } from "../components/Button.js";
import { AuthShell, formActionProps } from "../components/AuthShell.js";
import { Notice } from "../components/Notice.js";
import { TextField } from "../components/TextField.js";
import type { FormAction } from "../components/types.js";
import { useId } from "react";
import { copy, fill, signInWords } from "./copy.js";
import styles from "./Screen.module.css";

export type SignInState = "idle" | "submitting" | "invalid" | "error" | "rate-limited" | "offline";
export type SignInMethod = "organisation" | "magic-link";
export type SignInNotice = "not-completed" | "session-ended" | "start-failed" | "unavailable" | "offline";

export interface SignInScreenProps {
  /** Posts `email` (and the hidden `next`) to the magic-link request. */
  action?: FormAction;
  /** State of the magic-link form. */
  state?: SignInState;
  /** The address the person typed, kept after an error or offline attempt. Never put in the URL. */
  email?: string;
  /** Present when sign-in was started by an agent's connection request or an approval link (the URL to return to). */
  next?: string;
  /** What `next` leads back to: an agent's connection (default) or an approval page. Picks the lead. */
  nextPurpose?: "connect" | "approve";
  /** Request id for the error notice (magic-link "error", or the "start-failed" notice). */
  reference?: string;
  /** "empty" or "format" for the invalid state. */
  invalidReason?: "empty" | "format";
  stageName?: string;
  /**
   * The ways to sign in on this install. A production install passes `["organisation"]` only and then
   * no email field or link wording is rendered. Left out: the M1 magic-link screen as it was.
   */
  methods?: readonly SignInMethod[];
  /** From the install's configuration (ORGANISATION_NAME); never from the organisation's sign-in. */
  organisationName?: string;
  /** POST; starts the trip to the organisation's sign-in and carries the hidden `next`. */
  organisationAction?: FormAction;
  /** After pressing: "Opening sign-in…", busy, not pressable twice. */
  organisationPending?: boolean;
  /** Shown between the title and the rest. Notices present on load are not live regions. */
  notice?: SignInNotice;
}

/** /sign-in (m1 design.md "Screen 1: Sign in"; m2-org-sign-in screens.md S1, S2, S3a, S4). */
export function SignInScreen({
  action,
  state = "idle",
  email,
  next,
  nextPurpose = "connect",
  reference,
  invalidReason = "format",
  stageName,
  methods = ["magic-link"],
  organisationName,
  organisationAction,
  organisationPending = false,
  notice,
}: SignInScreenProps) {
  const c = copy.signIn;
  const o = copy.orgSignIn;
  const organisationId = useId();
  const magicLinkId = useId();
  const organisation = methods.includes("organisation");
  const magicLink = methods.includes("magic-link");
  const both = organisation && magicLink;
  const connecting = next !== undefined;
  const words = { signIn: signInWords(organisationName), SignIn: signInWords(organisationName, true) };
  const named = organisationName !== undefined && organisationName.trim() !== "";

  const topNotice =
    notice === "not-completed" ? (
      <Notice tone="neutral" title={o.notCompletedTitle}>
        <p>{fill(o.notCompletedBody, words)}</p>
      </Notice>
    ) : notice === "session-ended" ? (
      <Notice tone="neutral" title={o.sessionEndedTitle}>
        <p>{o.sessionEndedBody}</p>
      </Notice>
    ) : notice === "start-failed" ? (
      <Notice tone="danger" title={o.startFailedTitle} live="alert" {...(reference !== undefined ? { reference } : {})}>
        <p>{o.startFailedBody}</p>
      </Notice>
    ) : notice === "unavailable" ? (
      <Notice tone="danger" title={fill(o.unavailableTitle, words)} live="alert">
        <p>{o.unavailableBody}</p>
      </Notice>
    ) : notice === "offline" ? (
      <Notice tone="neutral" title={o.offlineTitle} live="status">
        <p>{o.offlineBody}</p>
      </Notice>
    ) : null;

  const organisationLead = (
    <p className={styles.lead}>{fill(connecting ? (nextPurpose === "approve" ? o.leadApproving : o.leadConnecting) : o.lead, words)}</p>
  );
  const organisationForm = (
    <form className={styles.form} method="post" {...formActionProps(organisationAction)}>
      {next !== undefined && <input type="hidden" name="next" value={next} />}
      <Button type="submit" fullWidth isPending={organisationPending} pendingLabel={o.submitPending}>
        {named ? fill(o.submitNamed, { name: organisationName }) : o.submit}
      </Button>
    </form>
  );

  const magicLinkNotices = (
    <>
      {state === "error" && (
        <Notice tone="danger" title={c.errorTitle} live="alert" {...(reference !== undefined && notice !== "start-failed" ? { reference } : {})}>
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
    </>
  );
  const magicLinkForm = (
    <form className={styles.form} method="post" noValidate {...formActionProps(action)}>
      {next !== undefined && <input type="hidden" name="next" value={next} />}
      <TextField
        label={c.emailLabel}
        name="email"
        type="email"
        autoComplete="email"
        isRequired
        autoFocus={state === "invalid"}
        {...(both ? { description: o.magicLinkDescription } : {})}
        {...(email !== undefined ? { defaultValue: email } : {})}
        {...(state === "invalid" ? { errorMessage: invalidReason === "empty" ? c.errorEmpty : c.errorFormat } : {})}
      />
      <Button type="submit" fullWidth variant={both ? "ghost" : "primary"} isPending={state === "submitting"} pendingLabel={c.submitPending}>
        {c.submit}
      </Button>
    </form>
  );

  return (
    <AuthShell {...(stageName !== undefined ? { stageName } : {})}>
      <h1 className={styles.title}>{c.title}</h1>
      {topNotice}
      {both ? (
        <>
          <section className={styles.method} aria-labelledby={organisationId}>
            <h2 className={styles.h2} id={organisationId}>
              {words.SignIn}
            </h2>
            {organisationLead}
            {organisationForm}
          </section>
          <section className={styles.method} aria-labelledby={magicLinkId}>
            <h2 className={styles.h2} id={magicLinkId}>
              {o.magicLinkHeading}
            </h2>
            {magicLinkNotices}
            {magicLinkForm}
          </section>
        </>
      ) : organisation ? (
        <>
          {organisationLead}
          {organisationForm}
          <p className={styles.muted}>{o.footnote}</p>
        </>
      ) : (
        <>
          <p className={styles.lead}>{connecting ? (nextPurpose === "approve" ? c.leadApproving : c.leadConnecting) : c.lead}</p>
          {magicLinkNotices}
          {magicLinkForm}
          <p className={styles.muted}>{c.footnote}</p>
        </>
      )}
    </AuthShell>
  );
}
