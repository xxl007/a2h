import { Label, Radio, RadioGroup } from "react-aria-components";
import { cx } from "./cx.js";
import styles from "./ChoiceGroup.module.css";

export interface ChoiceOption<V extends string> {
  value: V;
  label: string;
}

export interface ChoiceGroupProps<V extends string> {
  /** Visible name of the group ("Show"). */
  label: string;
  options: readonly ChoiceOption<V>[];
  value: V;
  onChange: (value: V) => void;
}

/**
 * One choice of a few, as 44 px options: a React Aria radio group (one Tab stop, arrow keys move).
 * Every option keeps a radio mark, filled when chosen, so the choice is never said by colour alone.
 */
export function ChoiceGroup<V extends string>({ label, options, value, onChange }: ChoiceGroupProps<V>) {
  return (
    <RadioGroup className={cx(styles.group)} value={value} onChange={(next) => onChange(next as V)} orientation="horizontal">
      <Label className={styles.label}>{label}</Label>
      <div className={styles.options}>
        {options.map((option) => (
          <Radio key={option.value} value={option.value} className={cx(styles.option)}>
            <span className={styles.mark} aria-hidden="true" />
            {option.label}
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}
