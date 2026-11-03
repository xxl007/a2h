import { useEffect, useId, useRef, useState } from "react";
import { copy, fill } from "../screens/copy.js";
import styles from "./QuestionEditor.module.css";

export interface QuestionStatus {
  /** UTF-16 code units, the unit the protocol's max length counts (zod `.max`). */
  count: number;
  /** Characters over the limit, 0 when it fits. */
  over: number;
  empty: boolean;
  /** Send is available only when the question is not blank and fits the limit. */
  canSend: boolean;
  edited: boolean;
}

/** Pure: what the editor shows and whether Send is available (spec "Over the limit", "Restore agent draft"). */
export function questionStatus(value: string, agentDraft: string, maxLength: number): QuestionStatus {
  const count = value.length;
  const over = Math.max(0, count - maxLength);
  const empty = value.trim().length === 0;
  return { count, over, empty, canSend: !empty && over === 0, edited: value !== agentDraft };
}

export function characters(n: number): string {
  return n === 1 ? copy.approval.characters.one : fill(copy.approval.characters.other, { n: String(n) });
}

export interface QuestionEditorProps {
  /** The current text. Controlled when `onChange` is given. */
  value: string;
  onChange?: (value: string) => void;
  /** The agent's text, byte for byte; "Restore agent draft" brings it back exactly. */
  agentDraft: string;
  maxLength: number;
  /** Form field name posted with the decision. */
  name?: string;
  /** While a decision is being recorded. */
  isReadOnly?: boolean;
  /** Id of the field error, so the Send button can point at it. */
  errorId?: string;
}

/**
 * The question, editable in place (PRD §6, skill §4a): a native textarea, so Enter inserts a
 * line break and never submits; the count and limit beneath it; "Agent draft" while unchanged,
 * "Restore agent draft" once the text differs. No edit mode, no model, no autosave elsewhere.
 */
export function QuestionEditor({
  value: valueProp,
  onChange,
  agentDraft,
  maxLength,
  name = "question",
  isReadOnly = false,
  errorId: errorIdProp,
}: QuestionEditorProps) {
  const c = copy.approval;
  const [own, setOwn] = useState(valueProp);
  const value = onChange ? valueProp : own;
  const setValue = (next: string) => (onChange ? onChange(next) : setOwn(next));
  const id = useId();
  const ids = { field: `${id}-q`, description: `${id}-d`, count: `${id}-c`, error: errorIdProp ?? `${id}-e` };
  const field = useRef<HTMLTextAreaElement>(null);
  const [announcement, setAnnouncement] = useState("");
  // Restore needs script; with JavaScript off the page is a plain textarea and two submit buttons (D7).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const s = questionStatus(value, agentDraft, maxLength);
  const error = s.empty ? c.errorEmpty : s.over > 0 ? fill(c.errorOver, { over: characters(s.over) }) : undefined;

  const restore = () => {
    setValue(agentDraft);
    setAnnouncement(c.restored);
    field.current?.focus();
  };

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={ids.field}>
        {c.questionLabel}
      </label>
      <p className={styles.description} id={ids.description}>
        {c.questionDescription}
      </p>
      <textarea
        ref={field}
        id={ids.field}
        className={styles.textarea}
        name={name}
        value={value}
        rows={8}
        readOnly={isReadOnly}
        spellCheck
        aria-describedby={`${ids.description} ${ids.count}${error ? ` ${ids.error}` : ""}`}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          setAnnouncement("");
          setValue(event.target.value);
        }}
      />
      <div className={styles.meta}>
        <span className={styles.origin}>
          {!s.edited ? (
            <span className={styles.agentDraft}>{c.agentDraft}</span>
          ) : hydrated && !isReadOnly ? (
            <button type="button" className={styles.restore} onClick={restore}>
              {c.restore}
            </button>
          ) : null}
        </span>
        <span className={`${styles.count} ${s.over > 0 ? styles.countOver : ""}`} id={ids.count}>
          <span aria-hidden="true">{fill(c.count, { count: String(s.count), max: String(maxLength) })}</span>
          <span className={styles.visuallyHidden}>
            {fill(c.countAccessible, { count: String(s.count), max: String(maxLength) })}
          </span>
          {s.over > 0 && <span> · {fill(c.over, { over: String(s.over) })}</span>}
        </span>
      </div>
      <p className={styles.error} id={ids.error} aria-live="polite">
        {error ? `Error: ${error}` : ""}
      </p>
      <span className={styles.visuallyHidden} role="status">
        {announcement}
      </span>
    </div>
  );
}
