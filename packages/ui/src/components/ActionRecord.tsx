import { copy, fill } from "../screens/copy.js";
import { LocalTime } from "./LocalTime.js";
import { recordSentence, type RecordEntry } from "./people.js";
import styles from "./ActionRecord.module.css";

export interface ActionRecordProps {
  /** Newest first, as the server sends them. */
  entries: readonly RecordEntry[];
  /** Fixed zone, for stories and tests only. */
  timeZone?: string;
}

/**
 * The record of administrator actions: an ordered list, newest first, read-only. No entry carries a
 * control: nothing can be selected, edited, deleted or exported (screens.md P14).
 */
export function ActionRecord({ entries, timeZone }: ActionRecordProps) {
  const c = copy.record;
  return (
    <ol className={styles.list} aria-label={c.listLabel}>
      {entries.map((entry) => (
        <li key={entry.id} className={styles.entry} tabIndex={-1} data-entry={entry.id}>
          <p className={styles.what}>{recordSentence(entry)}</p>
          <p className={styles.when}>
            <LocalTime iso={entry.at} {...(timeZone !== undefined ? { timeZone } : {})} />
          </p>
          <p className={styles.who}>
            {entry.by.email === entry.about.email
              ? fill(c.by, { by: entry.by.email })
              : fill(c.byAbout, { by: entry.by.email, about: entry.about.email })}
          </p>
        </li>
      ))}
    </ol>
  );
}
