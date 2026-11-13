import type { RefObject } from "react";
import { Button as AriaButton, Input, Label, SearchField as AriaSearchField, Text } from "react-aria-components";
import { cx } from "./cx.js";
import buttonStyles from "./Button.module.css";
import fieldStyles from "./TextField.module.css";
import styles from "./SearchField.module.css";

export interface SearchFieldProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  /** Visible label of the clear button ("Clear") and its accessible name ("Clear search"), which contains it. */
  clearLabel: string;
  clearName: string;
  /** Lets a screen move focus back to the field (e.g. after "Clear search"). */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * React Aria search field on the TextField styles: visible label, description, a clear button once
 * there is text, Escape clears. The input has no `name`: what is typed stays in the browser and is
 * never part of a form submission (screens.md P5).
 */
export function SearchField({ label, description, value, onChange, clearLabel, clearName, inputRef }: SearchFieldProps) {
  return (
    <AriaSearchField className={cx(fieldStyles.field)} value={value} onChange={onChange} autoComplete="off">
      <Label className={fieldStyles.label}>{label}</Label>
      <div className={styles.row}>
        <Input className={cx(fieldStyles.input, styles.input)} spellCheck={false} {...(inputRef ? { ref: inputRef } : {})} />
        <AriaButton className={cx(buttonStyles.button, buttonStyles.ghost, styles.clear)} aria-label={clearName}>
          {clearLabel}
        </AriaButton>
      </div>
      {description !== undefined && (
        <Text slot="description" className={fieldStyles.description}>
          {description}
        </Text>
      )}
    </AriaSearchField>
  );
}
