import { ButtonLink } from "../components/Button.js";
import { AuthShell } from "../components/AuthShell.js";
import { copy } from "./copy.js";
import styles from "./Screen.module.css";

export interface SignedOutScreenProps {
  signInHref?: string;
  stageName?: string;
}

/** /signed-out (design.md "Screen 5: Signed out"). */
export function SignedOutScreen({ signInHref = "/sign-in", stageName }: SignedOutScreenProps) {
  const c = copy.signedOut;
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
