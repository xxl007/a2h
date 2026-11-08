import { useId, type Ref } from "react";
import { Button as AriaButton, DropZone, FileTrigger, type DropItem } from "react-aria-components";
import { copy } from "../screens/copy.js";
import { cx } from "./cx.js";
import { acceptAttribute } from "./FileList.js";
import buttonStyles from "./Button.module.css";
import styles from "./FileUpload.module.css";

export interface FileUploadProps {
  /** Allowed media types (ApprovalFileRules.accept). */
  accept: readonly string[];
  /** Called with every file chosen, dropped or pasted, in order. The app checks limits and uploads. */
  onAddFiles?: (files: File[]) => void;
  isDisabled?: boolean;
  /** Why adding is unavailable (five files listed, offline), shown under the control. */
  disabledReason?: string;
  /** Lets the page move focus here after the last file is removed. */
  buttonRef?: Ref<HTMLButtonElement>;
}

async function filesFrom(items: DropItem[]): Promise<File[]> {
  const files = items.filter((i) => i.kind === "file");
  return Promise.all(files.map((i) => i.getFile()));
}

/**
 * Adding files (m2-attachments design.md F0): a drop zone around one "Choose files" button.
 * The button opens the system picker (on a phone: photo library, camera or files). The drop
 * zone also takes a paste (Ctrl/Cmd+V) when focused. The hidden input has no name, so a file
 * is never posted with the decision form; the app uploads it straight to storage.
 */
export function FileUpload({ accept, onAddFiles, isDisabled = false, disabledReason, buttonRef }: FileUploadProps) {
  const c = copy.approval.files;
  const reasonId = useId();
  const add = (files: File[]) => {
    if (!isDisabled && files.length > 0) onAddFiles?.(files);
  };
  return (
    <div className={styles.upload}>
      <DropZone
        className={cx(styles.zone)}
        aria-label={c.dropLabel}
        isDisabled={isDisabled}
        getDropOperation={() => (isDisabled ? "cancel" : "copy")}
        onDrop={(e) => {
          void filesFrom(e.items).then(add);
        }}
      >
        {({ isDropTarget }) => (
          <>
            <span className={styles.hint} aria-hidden="true">
              {isDropTarget ? c.dropActive : c.dropHint}
            </span>
            <FileTrigger acceptedFileTypes={[acceptAttribute(accept)]} allowsMultiple onSelect={(list) => add(list ? Array.from(list) : [])}>
              <AriaButton
                ref={buttonRef}
                className={cx(buttonStyles.button, buttonStyles.ghost, styles.choose)}
                isDisabled={isDisabled}
                {...(disabledReason ? { "aria-describedby": reasonId } : {})}
              >
                {c.choose}
              </AriaButton>
            </FileTrigger>
          </>
        )}
      </DropZone>
      {disabledReason && (
        <p className={styles.reason} id={reasonId}>
          {disabledReason}
        </p>
      )}
    </div>
  );
}
