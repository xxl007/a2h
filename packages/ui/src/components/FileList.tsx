import { useEffect, useRef, useState } from "react";
import { copy, fill } from "../screens/copy.js";
import { StatusPill, type StatusPillTone } from "./StatusPill.js";
import styles from "./FileList.module.css";

/** One state per file (spec platform/attachments "Every file is scanned before it can be sent"). */
export type ApprovalFileState = "uploading" | "checking" | "ready" | "refused";

/**
 * Why a file was refused. `type`, `size`, `count`, `malware`, `not_checked` and `upload_failed`
 * are D1's reasons; `total` is the page's split of `size` when the file itself fits but the
 * request would go over the total (the add action knows which limit failed).
 */
export type ApprovalFileRefusal = "type" | "size" | "total" | "count" | "malware" | "not_checked" | "upload_failed";

/** A file as the approval page shows it. Names are shown as text, never logged by the UI. */
export interface ApprovalFile {
  /** Opaque file id (the protocol `ref`), or a local id for a file refused before it was stored. */
  id: string;
  /** As the principal's device named it. */
  name: string;
  /** The type recorded by the content check, or the browser's declared type until then. */
  mediaType: string;
  sizeBytes: number;
  state: ApprovalFileState;
  /** 0..1 while uploading; absent until the browser reports progress. */
  progress?: number;
  /** Only when `state` is "refused". */
  refusal?: ApprovalFileRefusal;
  /** A remove was asked and is being recorded. */
  removing?: boolean;
}

/** The constants packages/protocol fixes: allowed media types (in display order) and the limits in bytes. */
export interface ApprovalFileRules {
  accept: readonly string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

const f = copy.approval.files;
const KB = 1024;
const MB = 1024 * 1024;

/** Sizes in binary units, as the limits are stated (25 MB = 25 × 1024 × 1024 bytes). */
export function formatFileSize(bytes: number): string {
  if (bytes === 1) return f.size.byte;
  if (bytes < KB) return fill(f.size.bytes, { n: String(bytes) });
  const kb = Math.round(bytes / KB);
  if (kb < 1024) return fill(f.size.kb, { n: String(kb) });
  return fill(f.size.mb, { n: String(Math.round((bytes / MB) * 10) / 10) });
}

export function fileTypeLabel(mediaType: string): string {
  return (f.types as Record<string, string>)[mediaType] ?? f.typeOther;
}

const extensions: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "text/plain": [".txt"],
  "text/csv": [".csv"],
  "text/markdown": [".md", ".markdown"],
};

/**
 * The file input's `accept`: the media types, plus extensions for the types browsers often
 * do not know by name (Markdown, CSV). No `image/*` and no HEIC: with image/jpeg listed and
 * HEIC not, phones hand over a JPEG when a photo is chosen.
 */
export function acceptAttribute(accept: readonly string[]): string {
  return [...accept, ...accept.flatMap((t) => extensions[t] ?? [])].join(",");
}

/** "PDF, PNG, JPEG, WebP, plain text, CSV or Markdown". */
export function typesSentence(accept: readonly string[]): string {
  const names = accept.map((t) => (f.typeNames as Record<string, string>)[t] ?? t);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${f.or} ${names[names.length - 1]}`;
}

function ruleValues(rules?: ApprovalFileRules): Record<string, string> {
  if (!rules) return {};
  return {
    maxFiles: String(rules.maxFiles),
    maxFile: formatFileSize(rules.maxFileBytes),
    maxTotal: formatFileSize(rules.maxTotalBytes),
    types: typesSentence(rules.accept),
  };
}

/**
 * The refusal sentence. `not_checked` names password-protected PDFs only when the file is a PDF
 * (`mediaType` "application/pdf"); any other type gets the remove-and-add-again sentence.
 */
export function refusalText(reason: ApprovalFileRefusal, rules?: ApprovalFileRules, mediaType?: string): string {
  const sentence = reason === "not_checked" && mediaType === "application/pdf" ? f.refusal.notCheckedPdf : f.refusal[reason];
  return fill(sentence, ruleValues(rules));
}

export function fileHint(rules: ApprovalFileRules): string {
  return fill(f.hint, ruleValues(rules));
}

export interface FilesGate {
  canSend: boolean;
  /** What to say next to Send: a refused file first (it needs an action), then uploads, then checks. */
  reason: "refused" | "uploading" | "checking" | null;
  refused: number;
}

/** Pure: Send is available only when every listed file is ready (spec "Send waits for checking"). */
export function filesGate(files: readonly ApprovalFile[]): FilesGate {
  const refused = files.filter((x) => x.state === "refused").length;
  if (refused > 0) return { canSend: false, reason: "refused", refused };
  if (files.some((x) => x.state === "uploading")) return { canSend: false, reason: "uploading", refused: 0 };
  if (files.some((x) => x.state === "checking")) return { canSend: false, reason: "checking", refused: 0 };
  return { canSend: true, reason: null, refused: 0 };
}

export function gateText(gate: FilesGate): string | undefined {
  if (gate.reason === "refused") return gate.refused === 1 ? f.gateRefused.one : fill(f.gateRefused.other, { n: String(gate.refused) });
  if (gate.reason === "uploading") return f.gateUploading;
  if (gate.reason === "checking") return f.gateChecking;
  return undefined;
}

function stateMessage(file: ApprovalFile, rules?: ApprovalFileRules): string {
  const a = f.announce;
  if (file.state === "uploading") return fill(a.uploading, { name: file.name });
  if (file.state === "checking") return fill(a.checking, { name: file.name });
  if (file.state === "ready") return fill(a.ready, { name: file.name });
  return fill(a.refused, { name: file.name, reason: file.refusal ? refusalText(file.refusal, rules, file.mediaType) : "" }).trim();
}

/**
 * Pure: what the polite live region says when the list changes. Nothing on first render; one
 * sentence per new file or state change (not per percent of progress), one per removal, and
 * "Every file is ready. Send is available." when the files stop blocking Send.
 */
export function fileAnnouncements(prev: readonly ApprovalFile[] | undefined, next: readonly ApprovalFile[], rules?: ApprovalFileRules): string[] {
  if (prev === undefined) return [];
  const out: string[] = [];
  for (const file of next) {
    const before = prev.find((p) => p.id === file.id);
    if (!before || before.state !== file.state) out.push(stateMessage(file, rules));
  }
  for (const file of prev) if (!next.some((n) => n.id === file.id)) out.push(fill(f.announce.removed, { name: file.name }));
  if (next.length > 0 && !filesGate(prev).canSend && filesGate(next).canSend) out.push(f.announce.allReady);
  return out;
}

/** Files that count towards what the participant receives (refused ones never do). */
export function filesFact(files: readonly ApprovalFile[]): string {
  const counted = files.filter((x) => x.state !== "refused");
  if (counted.length === 0) return f.factNone;
  const size = formatFileSize(counted.reduce((sum, x) => sum + x.sizeBytes, 0));
  return counted.length === 1 ? fill(f.factCount.one, { size }) : fill(f.factCount.other, { n: String(counted.length), size });
}

const pill: Record<ApprovalFileState, StatusPillTone> = { uploading: "pending", checking: "pending", ready: "success", refused: "danger" };

function pillText(file: ApprovalFile): string {
  if (file.state === "uploading") {
    return file.progress === undefined ? f.pill.uploadingStarted : fill(f.pill.uploading, { percent: `${Math.round(file.progress * 100)}%` });
  }
  return f.pill[file.state];
}

export interface FileListProps {
  files: readonly ApprovalFile[];
  /** For the limits and types named in refusal reasons. */
  rules?: ApprovalFileRules;
  /** "edit": states, Open on ready files, Remove on every file. "read": the files as sent, Open only. */
  mode: "edit" | "read";
  /** Id of the heading that names the list. */
  "aria-labelledby": string;
  onOpen?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** While a decision is being recorded: nothing can be removed. */
  isDisabled?: boolean;
  /** Where focus goes when the last file is removed (the "Choose files" button). */
  onEmptied?: () => void;
}

/**
 * The files of a request (m2-attachments design.md F0). Each row: name (plain text, the
 * principal's own), type and size, the state in words, a progress bar while uploading, the
 * reason when refused, then Open and Remove. Native buttons, 44 px tall, named after the file.
 */
export function FileList({ files, rules, mode, "aria-labelledby": labelledBy, onOpen, onRemove, isDisabled = false, onEmptied }: FileListProps) {
  const rows = useRef(new Map<string, HTMLLIElement>());
  const [moveFocus, setMoveFocus] = useState<{ removed: string; to: string | null } | null>(null);

  // After a removal is confirmed (the file left the list), focus the next file, else the previous, else the add button.
  useEffect(() => {
    if (!moveFocus || files.some((x) => x.id === moveFocus.removed)) return;
    setMoveFocus(null);
    const row = moveFocus.to ? rows.current.get(moveFocus.to) : undefined;
    const target = row?.querySelector<HTMLButtonElement>("button:not([disabled])");
    if (target) target.focus();
    else onEmptied?.();
  }, [files, moveFocus, onEmptied]);

  if (files.length === 0) return null;

  const remove = (id: string) => {
    const i = files.findIndex((x) => x.id === id);
    const neighbour = files[i + 1] ?? files[i - 1];
    setMoveFocus({ removed: id, to: neighbour?.id ?? null });
    onRemove?.(id);
  };

  return (
    <ul className={styles.list} aria-labelledby={labelledBy}>
      {files.map((file) => (
        <li
          key={file.id}
          className={styles.item}
          ref={(el) => {
            if (el) rows.current.set(file.id, el);
            else rows.current.delete(file.id);
          }}
        >
          <div className={styles.head}>
            <div className={styles.id}>
              <span className={styles.name}>{file.name}</span>
              <span className={styles.meta}>{fill(f.meta, { type: fileTypeLabel(file.mediaType), size: formatFileSize(file.sizeBytes) })}</span>
            </div>
            {mode === "edit" && <StatusPill tone={pill[file.state]}>{pillText(file)}</StatusPill>}
          </div>
          {mode === "edit" && file.state === "uploading" && (
            <progress
              className={styles.progress}
              aria-label={fill(f.progressLabel, { name: file.name })}
              max={100}
              {...(file.progress !== undefined ? { value: Math.round(file.progress * 100) } : {})}
            />
          )}
          {mode === "edit" && file.state === "refused" && file.refusal && <p className={styles.reason}>{refusalText(file.refusal, rules, file.mediaType)}</p>}
          <div className={styles.actions}>
            {file.state === "ready" && (
              <button type="button" className={styles.action} aria-label={fill(f.openLabel, { name: file.name })} onClick={() => onOpen?.(file.id)}>
                {f.open}
              </button>
            )}
            {mode === "edit" && (
              <button
                type="button"
                className={styles.action}
                aria-label={fill(file.removing ? f.removingLabel : f.removeLabel, { name: file.name })}
                disabled={isDisabled || file.removing === true}
                onClick={() => remove(file.id)}
              >
                {file.removing ? f.removing : f.remove}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The polite live region of the files section: present and empty from the first paint. */
export function FileAnnouncer({ files, rules }: { files: readonly ApprovalFile[]; rules?: ApprovalFileRules }) {
  const prev = useRef<readonly ApprovalFile[] | undefined>(undefined);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const lines = fileAnnouncements(prev.current, files, rules);
    prev.current = files;
    if (lines.length > 0) setMessage(lines.join(" "));
  }, [files, rules]);
  return (
    <div className={styles.visuallyHidden} role="status" aria-live="polite">
      {message}
    </div>
  );
}
