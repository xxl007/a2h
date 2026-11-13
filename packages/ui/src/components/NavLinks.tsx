import { cx } from "./cx.js";
import styles from "./NavLinks.module.css";

export interface NavLinkItem {
  label: string;
  href: string;
  /** The page being shown: `aria-current="page"`, strong, not underlined. */
  current?: boolean;
}

export interface NavLinksProps {
  /** Names the navigation region ("A2H", "Administration"). */
  label: string;
  links: readonly NavLinkItem[];
  /** "header": inside the AuthShell bar. "tabs": under a page title, with a rule beneath. */
  variant?: "header" | "tabs";
}

/** A short list of page links in a named navigation region; every link is a 44 px target. */
export function NavLinks({ label, links, variant = "header" }: NavLinksProps) {
  return (
    <nav aria-label={label} className={styles.nav}>
      <ul className={cx(styles.list, variant === "tabs" && styles.tabs)}>
        {links.map((link) => (
          <li key={link.href}>
            <a className={styles.link} href={link.href} {...(link.current ? { "aria-current": "page" as const } : {})}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
