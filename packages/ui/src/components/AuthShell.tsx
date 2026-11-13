import type { ReactNode } from "react";
import { Button } from "./Button.js";
import { NavLinks, type NavLinkItem } from "./NavLinks.js";
import { copy } from "../screens/copy.js";
import type { FormAction } from "./types.js";
import styles from "./AuthShell.module.css";

export interface AuthShellProps {
  children: ReactNode;
  /** Non-production stages only (e.g. "dev", "pr-52"). Never passed on prod. */
  stageName?: string;
  /** Signed-in principal's own address, shown with a sign-out action. */
  account?: { email: string; signOutAction?: FormAction };
  width?: "narrow" | "wide";
  /**
   * Header links, before "Signed in as": "Connected apps" for everyone, "People and access" for
   * administrators only (the app decides which to pass). Rendered as `<nav aria-label="A2H">`.
   */
  links?: readonly NavLinkItem[];
}

/** Page frame for the sign-in, consent and account screens: header, optional stage line, one main column. */
export function AuthShell({ children, stageName, account, width = "narrow", links }: AuthShellProps) {
  const nav = links !== undefined && links.length > 0 ? <NavLinks label={copy.nav.label} links={links} /> : null;
  return (
    <div className={styles.page}>
      {/* One banner landmark holds the bar and, on non-production stages, the stage line (axe `region`). */}
      <header className={styles.banner}>
        <div className={styles.header}>
          <span className={styles.wordmark}>A2H</span>
          {account && (
            <div className={styles.account}>
              {nav}
              <span>
                Signed in as <span className={styles.email}>{account.email}</span>
              </span>
              <form method="post" {...formActionProps(account.signOutAction)}>
                <Button type="submit" variant="ghost">
                  Sign out
                </Button>
              </form>
            </div>
          )}
          {!account && nav}
        </div>
        {stageName !== undefined && (
          <p className={styles.stage} role="note">
            Test stage {stageName}. Not the live service.
          </p>
        )}
      </header>
      <main className={`${styles.main} ${width === "wide" ? styles.wide : ""}`}>{children}</main>
    </div>
  );
}

/** A server action or URL when given; in Storybook (no action) the form does not navigate. */
export function formActionProps(action: FormAction | undefined) {
  if (action === undefined) {
    return { onSubmit: (event: { preventDefault: () => void }) => event.preventDefault() };
  }
  return { action };
}
