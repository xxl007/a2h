import type { ReactNode } from "react";
import { Button as AriaButton, Link as AriaLink } from "react-aria-components";
import { cx } from "./cx.js";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "ghost";

export interface ButtonProps {
  children: ReactNode;
  variant?: ButtonVariant;
  type?: "button" | "submit";
  /** Submitting: the label is replaced by `pendingLabel` and the button is announced busy. */
  isPending?: boolean;
  pendingLabel?: string;
  isDisabled?: boolean;
  fullWidth?: boolean;
  name?: string;
  value?: string;
  /** Accessible name when the visible label is ambiguous in a list (e.g. "Disconnect Claude (claude.ai)"). */
  "aria-label"?: string;
  onPress?: () => void;
}

/** React Aria button, 44 px minimum target; one accent for every primary action (ADR 0003 D3). */
export function Button({
  children,
  variant = "primary",
  type = "button",
  isPending = false,
  pendingLabel,
  isDisabled = false,
  fullWidth = false,
  name,
  value,
  onPress,
  "aria-label": ariaLabel,
}: ButtonProps) {
  return (
    <AriaButton
      className={cx(styles.button, styles[variant], fullWidth && styles.full)}
      type={type}
      isPending={isPending}
      isDisabled={isDisabled}
      {...(name !== undefined ? { name } : {})}
      {...(value !== undefined ? { value } : {})}
      {...(onPress ? { onPress } : {})}
      {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
    >
      {isPending && pendingLabel ? pendingLabel : children}
    </AriaButton>
  );
}

export interface ButtonLinkProps {
  children: ReactNode;
  href: string;
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

/** Navigation that looks like a button (e.g. "Send me a new link" to /sign-in). */
export function ButtonLink({ children, href, variant = "primary", fullWidth = false }: ButtonLinkProps) {
  return (
    <AriaLink className={cx(styles.button, styles[variant], fullWidth && styles.full)} href={href}>
      {children}
    </AriaLink>
  );
}

export interface TextLinkProps {
  children: ReactNode;
  href: string;
}

/** Inline link: accent and underlined, so it is never confused with accent-coloured machine text. */
export function TextLink({ children, href }: TextLinkProps) {
  return (
    <AriaLink className={cx(styles.textLink)} href={href}>
      {children}
    </AriaLink>
  );
}
