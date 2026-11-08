"use client";
// The approval page's client side (m2-approval-page design D7, design.md
// A1-A11): it holds the question while the principal edits it and the
// state of the decision (React 19 useActionState around the server action
// in app/approve/[id]/actions.ts). The form's action is that server action
// itself, so with JavaScript off the textarea and the two buttons post the
// form and the page comes back in its new state. Nothing here formats data,
// decides anything or calls a model; nothing is queued while offline.
//
// Files (m2-attachments task 5.2, design.md F0–F15): a FilesController
// (src/approval/files-client.ts) keeps `files` current; it lives above the
// error boundary, so a failed decision call keeps the files with the edits.
// The page refreshes the files' states while any is uploading or checking,
// and on focus; it stops when none is.
import { Component, useActionState, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { ApprovalScreen, copy, type ApprovalFile, type ApprovalFileRules, type ApprovalRequest, type ApprovalState } from "@a2h/ui";
import type { ApprovalActionState } from "../../src/approval/decide";
import { FilesController, xhrUploader, type FileActions } from "../../src/approval/files-client";
import type { ApprovalPageModel } from "../../src/approval/page-data";

type Action = (prev: ApprovalActionState, form: FormData) => Promise<ApprovalActionState>;

/** How often the page asks for the files' states while one is uploading or being checked. */
export const FILES_POLL_MS = 3000;

interface Common {
  email: string;
  signOutAction?: () => Promise<void>;
  stageName?: string;
}

export interface ApprovalFormProps extends Common {
  model: ApprovalPageModel;
  action: Action;
  /** The state to start from (tests; the server passes none). */
  initialState?: ApprovalActionState;
  /** The server actions for the request's files, bound to its id (app/approve/[id]/actions.ts). */
  fileActions?: FileActions;
  /** Allowed types and limits (packages/protocol constants, src/approval/files.ts FILE_RULES). */
  fileRules?: ApprovalFileRules;
}

interface FilesHandle {
  files: readonly ApprovalFile[];
  controller: FilesController | undefined;
}

/** The request's files and their controller; polls while `busy`. */
function useFiles(initial: readonly ApprovalFile[], actions: FileActions | undefined): FilesHandle {
  const [files, setFiles] = useState(initial);
  const ref = useRef<FilesController | undefined>(undefined);
  if (ref.current === undefined && actions !== undefined) {
    ref.current = new FilesController({
      actions,
      upload: xhrUploader(),
      openTab: () => window.open("about:blank", "_blank"),
      onChange: setFiles,
      initial,
    });
  }
  const controller = ref.current;
  const busy = files.some((f) => f.state === "uploading" || f.state === "checking");
  useEffect(() => {
    if (!busy || controller === undefined) return;
    const timer = window.setInterval(() => void controller.refresh(), FILES_POLL_MS);
    const now = () => {
      if (document.visibilityState === "visible") void controller.refresh();
    };
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [busy, controller]);
  return { files, controller };
}

/** The ApprovalScreen props of the files section. */
function fileProps(h: FilesHandle, rules: ApprovalFileRules | undefined) {
  const c = h.controller;
  return {
    files: h.files,
    ...(rules !== undefined ? { fileRules: rules } : {}),
    ...(c !== undefined
      ? {
          onAddFiles: (list: File[]) => void c.add(list),
          onRemoveFile: (id: string) => void c.remove(id),
          // Synchronous up to window.open: the tab is opened inside the click.
          onOpenFile: (id: string) => void c.open(id),
        }
      : {}),
  };
}

const c = copy.approval;

/** The document title of each state (design.md A7, A9, A10, A11). */
export function documentTitle(state: ApprovalState): string {
  switch (state) {
    case "sent":
    case "already-sent":
      return c.sentDocumentTitle;
    case "not-sent":
    case "already-not-sent":
      return c.notSentDocumentTitle;
    case "expired":
      return c.expiredDocumentTitle;
    case "wrong-principal":
      return c.wrongDocumentTitle;
    default:
      return c.documentTitle;
  }
}

function shell(p: Common) {
  return {
    email: p.email,
    ...(p.signOutAction !== undefined ? { signOutAction: p.signOutAction } : {}),
    ...(p.stageName !== undefined ? { stageName: p.stageName } : {}),
  };
}

export function ApprovalForm(props: ApprovalFormProps) {
  const { model } = props;
  if (model.kind === "awaiting") return <Deciding {...props} request={model.request} now={model.now} files={model.files} />;
  if (model.kind === "already-sent") return <AlreadySent {...props} model={model} />;
  const state: ApprovalState = model.kind;
  return (
    <>
      <title>{documentTitle(state)}</title>
      <ApprovalScreen state={state} {...shell(props)} {...("request" in model ? { request: model.request, decidedAt: model.decidedAt } : {})} />
    </>
  );
}

/** A8 / F13: the sent request, its files listed in read mode and openable. */
function AlreadySent(props: ApprovalFormProps & { model: Extract<ApprovalPageModel, { kind: "already-sent" }> }) {
  const { model } = props;
  const files = useFiles(model.files, props.fileActions);
  return (
    <>
      <title>{documentTitle("already-sent")}</title>
      <ApprovalScreen
        state="already-sent"
        {...shell(props)}
        request={model.request}
        decidedAt={model.decidedAt}
        question={model.question}
        {...fileProps(files, props.fileRules)}
      />
    </>
  );
}

/**
 * Keeps the principal's edits across a failed call: a network failure of
 * the server action rejects inside React's transition and reaches the
 * nearest error boundary; the boundary remounts the form in the error state
 * (A5) with the text as it was.
 */
function Deciding(props: ApprovalFormProps & { request: ApprovalRequest; now: string; files: readonly ApprovalFile[] }) {
  const latest = useRef<string | undefined>(undefined);
  const files = useFiles(props.files, props.fileActions);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const initial: ApprovalActionState = failed
    ? { state: "error", reference: "", ...(latest.current !== undefined ? { question: latest.current } : {}) }
    : props.initialState ?? { state: "awaiting" };
  return (
    <Boundary
      key={attempt}
      onError={() => {
        setFailed(true);
        setAttempt((a) => a + 1);
      }}
    >
      <Decision {...props} initial={initial} latest={latest} filesHandle={files} />
    </Boundary>
  );
}

class Boundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function questionOf(s: ApprovalActionState): string | undefined {
  return "question" in s ? s.question : undefined;
}

function Decision(
  props: ApprovalFormProps & { request: ApprovalRequest; now: string; initial: ApprovalActionState; latest: { current: string | undefined }; filesHandle: FilesHandle },
) {
  const { request, latest, filesHandle } = props;
  const [state, dispatch, pending] = useActionState(props.action, props.initial);

  // F11b: Send found a file not ready; the page shows the files as they are now.
  const notReady = state.state === "refused" && state.refusal === "files_not_ready";
  useEffect(() => {
    if (notReady) void filesHandle.controller?.refresh();
  }, [notReady, state, filesHandle.controller]);
  const [question, setQuestion] = useState(() => (state.state === "refused" || state.state === "error" ? questionOf(state) : undefined) ?? latest.current ?? request.agentDraft);
  const [pressed, setPressed] = useState<"send" | "dont_send">("send");
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Design A6: the browser says there is no connection.
    const update = () => setOffline(navigator.onLine === false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const change = (v: string) => {
    latest.current = v;
    setQuestion(v);
  };

  // Runs before React's own form-action handling: a decision taken offline is
  // stopped here (never queued, A6), and which button was pressed is noted
  // for the pending labels (A3). The header's Sign out form passes through.
  const capture = (event: SyntheticEvent<HTMLElement, Event>) => {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (!submitter || submitter.name !== "decision") return;
    if (navigator.onLine === false) {
      event.preventDefault();
      setOffline(true);
      return;
    }
    setOffline(false);
    setPressed(submitter.value === "dont_send" ? "dont_send" : "send");
  };

  const screen: ApprovalState = pending
    ? pressed === "dont_send"
      ? "not-sending"
      : "sending"
    : state.state === "awaiting" || state.state === "refused" || state.state === "error"
      ? offline
        ? "offline"
        : state.state
      : state.state;

  const outcome = state.state === "sent" || state.state === "already-sent";
  return (
    <div onSubmitCapture={capture}>
      <title>{documentTitle(screen)}</title>
      <ApprovalScreen
        state={screen}
        request={request}
        // The server's clock at render: the link validity line's first paint (design.md decision bar).
        now={props.now}
        question={outcome ? (questionOf(state) ?? question) : question}
        onQuestionChange={change}
        // The dispatch itself, not a wrapper: React then renders the server action's
        // hidden fields and the form posts with JavaScript off (D7).
        action={dispatch}
        {...shell(props)}
        {...("decidedAt" in state ? { decidedAt: state.decidedAt } : {})}
        {...(state.state === "refused" ? { refusal: state.refusal } : {})}
        {...(state.state === "error" && state.reference ? { reference: state.reference } : {})}
        {...fileProps(filesHandle, props.fileRules)}
      />
    </div>
  );
}
