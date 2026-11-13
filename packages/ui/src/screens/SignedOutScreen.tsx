import { ButtonLink } from "../components/Button.js";
import { AuthShell } from "../components/AuthShell.js";
import { copy, fill, signInWords } from "./copy.js";
import styles from "./Screen.module.css";

export interface SignedOutScreenProps {
  signInHref?: string;
  stageName?: string;
  /** The person had signed in through the organisation: one sentence more (from the sign-out flash, never the URL). */
  organisation?: boolean;
  organisationName?: string;
}

/** /signed-out (m1 design.md "Screen 5: Signed out"; m2-org-sign-in screens.md S5). */
export function SignedOutScreen({ signInHref = "/sign-in", stageName, organisation = false, organisationName }: SignedOutScreenProps) {
  const c = copy.signedOut;
  return (
    <AuthShell {...(stageName !== undefined ? { stageName } : {})}>
      <h1 className={styles.title}>{c.title}</h1>
      <p className={styles.lead}>{c.body}</p>
      {organisation && <p className={styles.body}>{fill(copy.orgSignIn.signedOutStill, { signIn: signInWords(organisationName) })}</p>}
      <div className={styles.actions}>
        <ButtonLink href={signInHref} fullWidth>
          {c.action}
        </ButtonLink>
      </div>
    </AuthShell>
  );
}
