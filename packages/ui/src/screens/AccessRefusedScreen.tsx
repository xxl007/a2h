import type { ReactNode } from "react";
import { ButtonLink } from "../components/Button.js";
import { AuthShell } from "../components/AuthShell.js";
import { fillNodes } from "../components/fillNodes.js";
import type { NavLinkItem } from "../components/NavLinks.js";
import type { FormAction } from "../components/types.js";
import { copy, fill, signInWords } from "./copy.js";
import styles from "./Screen.module.css";

/**
 * "Contact an administrator." or, when the install configured one, "Contact an administrator: **{contact}**."
 * The contact is free text (an address, a channel name): plain strong text that can wrap anywhere and
 * be copied. It is never a link, whatever it looks like (PM answer, design.md "Screens").
 */
export function administratorContactLine(contact: string | undefined, lower = false): ReactNode {
  const c = copy.accessRefused;
  if (contact === undefined || contact.trim() === "") return lower ? c.contactLower : c.contact;
  return fillNodes(lower ? c.contactLowerWith : c.contactWith, { contact: <strong className={styles.strong}>{contact}</strong> });
}

export interface AccessRefusedScreenProps {
  /**
   * "details": the details from the organisation's sign-in can't be accepted (one wording for every cause).
   * "access-removed": an administrator removed this person's access.
   */
  reason: "details" | "access-removed";
  organisationName?: string;
  /** ADMINISTRATOR_CONTACT, free text. */
  administratorContact?: string;
  /** Request id; shown for "details" only (the cause is logged under it, without the address). */
  reference?: string;
  tryAgainHref?: string;
  stageName?: string;
}

/** Sign-in refused (screens.md S3b, S3c). Shown signed out: no address, no name, no cause from the organisation's sign-in. */
export function AccessRefusedScreen({
  reason,
  organisationName,
  administratorContact,
  reference,
  tryAgainHref = "/sign-in",
  stageName,
}: AccessRefusedScreenProps) {
  const c = copy.accessRefused;
  const words = reason === "details" ? c.details : c.removed;
  return (
    <AuthShell {...(stageName !== undefined ? { stageName } : {})}>
      <h1 className={styles.title}>{words.title}</h1>
      <p className={styles.lead}>{fill(words.lead, { SignIn: signInWords(organisationName, true) })}</p>
      <p className={styles.body}>{fillNodes(words.body, { contact: administratorContactLine(administratorContact, reason === "access-removed") })}</p>
      {reason === "details" && reference !== undefined && <p className={styles.reference}>{fill(c.reference, { reference })}</p>}
      <div className={styles.actions}>
        <ButtonLink href={tryAgainHref} variant="ghost">
          {c.tryAgain}
        </ButtonLink>
      </div>
    </AuthShell>
  );
}

export interface NotAdministratorScreenProps {
  email: string;
  signOutAction?: FormAction;
  /** Header links, without "People and access". */
  links?: readonly NavLinkItem[];
  administratorContact?: string;
  clientsHref?: string;
  stageName?: string;
}

/** A signed-in person who is not an administrator opens an administrators' page (screens.md N1; HTTP 403). */
export function NotAdministratorScreen({
  email,
  signOutAction,
  links,
  administratorContact,
  clientsHref = "/account/clients",
  stageName,
}: NotAdministratorScreenProps) {
  const c = copy.notAdministrator;
  return (
    <AuthShell
      account={{ email, ...(signOutAction !== undefined ? { signOutAction } : {}) }}
      {...(links !== undefined ? { links } : {})}
      {...(stageName !== undefined ? { stageName } : {})}
    >
      <h1 className={styles.title}>{c.title}</h1>
      <p className={styles.lead}>{c.lead}</p>
      <p className={styles.body}>{fillNodes(c.body, { contact: administratorContactLine(administratorContact, true) })}</p>
      <div className={styles.actions}>
        <ButtonLink href={clientsHref} fullWidth>
          {c.action}
        </ButtonLink>
      </div>
    </AuthShell>
  );
}
