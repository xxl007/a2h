import { Button, TextLink } from "../components/Button.js";
import { AuthShell, formActionProps } from "../components/AuthShell.js";
import { ClientIdentity, originLabel } from "../components/ClientIdentity.js";
import { Notice } from "../components/Notice.js";
import type { ClientSummary, FormAction, ScopeName } from "../components/types.js";
import { copy, fill } from "./copy.js";
import styles from "./Screen.module.css";

export type ConsentState =
  | "ready"
  | "accepting"
  | "declining"
  | "error"
  | "offline"
  | "invalid"
  | "expired"
  | "declined";

export interface ConsentScreenProps {
  /** Absent in the invalid and expired states (the client could not be established). */
  client?: ClientSummary;
  /** Requested scopes; unknown scopes are never shown and must be refused before this screen. */
  scopes?: readonly ScopeName[];
  /** Host the browser returns to after the choice (the redirect URI's host). */
  returnOrigin?: string;
  /** The signed-in principal's own address. */
  email: string;
  /** Posts `accept=true|false` with the consent code (hidden fields supplied by the app). */
  action?: FormAction;
  /** Hidden fields the authorization server needs (e.g. consent_code); never displayed. */
  hiddenFields?: Record<string, string>;
  signOutAction?: FormAction;
  state?: ConsentState;
  reference?: string;
  clientsHref?: string;
  stageName?: string;
}

/** /consent (design.md "Screen 3: Consent"). */
export function ConsentScreen({
  client,
  scopes = ["a2h"],
  returnOrigin,
  email,
  action,
  hiddenFields = {},
  signOutAction,
  state = "ready",
  reference,
  clientsHref = "/account/clients",
  stageName,
}: ConsentScreenProps) {
  const c = copy.consent;
  const shell = {
    account: { email, ...(signOutAction !== undefined ? { signOutAction } : {}) },
    ...(stageName !== undefined ? { stageName } : {}),
  };

  if (state === "invalid" || state === "expired" || client === undefined) {
    const expired = state === "expired";
    return (
      <AuthShell {...shell}>
        <h1 className={styles.title}>{expired ? c.expiredTitle : c.invalidTitle}</h1>
        <Notice tone="danger" title={c.nothingConnected} {...(reference !== undefined ? { reference } : {})}>
          <p>{expired ? c.expiredBody : c.invalidBody}</p>
        </Notice>
      </AuthShell>
    );
  }

  if (state === "declined") {
    return (
      <AuthShell {...shell}>
        <h1 className={styles.title}>{c.declinedTitle}</h1>
        <p className={styles.lead}>{fill(c.declinedBody, { client: client.name })}</p>
      </AuthShell>
    );
  }

  const busy = state === "accepting" || state === "declining";
  return (
    <AuthShell {...shell}>
      <h1 className={styles.title}>{c.title}</h1>
      <ClientIdentity client={client} />
      <section className={styles.section} aria-labelledby="consent-scopes">
        <h2 id="consent-scopes" className={styles.h2}>
          {c.scopesHeading}
        </h2>
        <ul className={styles.scopes}>
          {scopes.map((scope) => (
            <li key={scope}>{c.scopes[scope]}</li>
          ))}
        </ul>
      </section>
      <Notice tone="platform" title={c.approvalTitle}>
        <p>{c.approvalBody}</p>
      </Notice>
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
      <div className={styles.stack}>
        <p className={styles.body}>
          {c.actsFor.split("{address}")[0]}
          <span className={styles.strong}>{email}</span>
          {c.actsFor.split("{address}")[1]}
        </p>
        {returnOrigin !== undefined && (
          <p className={styles.muted}>{fill(c.returnTo, { origin: originLabel(returnOrigin) })}</p>
        )}
      </div>
      <form className={styles.actions} method="post" {...formActionProps(action)}>
        {Object.entries(hiddenFields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Button
          type="submit"
          name="accept"
          value="true"
          isPending={state === "accepting"}
          pendingLabel={c.acceptPending}
          isDisabled={busy && state !== "accepting"}
        >
          {c.accept}
        </Button>
        <Button
          type="submit"
          name="accept"
          value="false"
          variant="ghost"
          isPending={state === "declining"}
          pendingLabel={c.declinePending}
          isDisabled={busy && state !== "declining"}
        >
          {c.decline}
        </Button>
      </form>
      <p className={styles.muted}>
        {c.disconnectLater}
        <TextLink href={clientsHref}>{c.clientsLink}</TextLink>.
      </p>
    </AuthShell>
  );
}
