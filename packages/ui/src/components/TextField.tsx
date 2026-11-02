import { FieldError, Input, Label, Text, TextField as AriaTextField } from "react-aria-components";
import { cx } from "./cx.js";
import styles from "./TextField.module.css";

export interface TextFieldProps {
  label: string;
  name: string;
  type?: "email" | "text";
  autoComplete?: string;
  defaultValue?: string;
  description?: string;
  /** Server-side or submit-time error. Shown under the field, linked by aria-describedby, prefixed "Error:". */
  errorMessage?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  autoFocus?: boolean;
}

/** React Aria text field: visible label, description and error associated with the input. */
export function TextField({
  label,
  name,
  type = "text",
  autoComplete,
  defaultValue,
  description,
  errorMessage,
  isRequired = false,
  isDisabled = false,
  autoFocus = false,
}: TextFieldProps) {
  return (
    <AriaTextField
      className={cx(styles.field)}
      name={name}
      type={type}
      isRequired={isRequired}
      isDisabled={isDisabled}
      isInvalid={errorMessage !== undefined}
      autoFocus={autoFocus}
      validationBehavior="aria"
      {...(autoComplete !== undefined ? { autoComplete } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
    >
      <Label className={styles.label}>{label}</Label>
      <Input className={cx(styles.input)} inputMode={type === "email" ? "email" : "text"} spellCheck={false} />
      {description !== undefined && (
        <Text slot="description" className={styles.description}>
          {description}
        </Text>
      )}
      <FieldError className={cx(styles.error)}>{errorMessage !== undefined ? `Error: ${errorMessage}` : null}</FieldError>
    </AriaTextField>
  );
}
