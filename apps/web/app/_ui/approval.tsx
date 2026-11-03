"use client";
// The approval page's client side (m2-approval-page design D7, design.md
// A1-A11): it holds the question while the principal edits it and the
// state of the decision (React 19 useActionState around the server action
// in app/approve/[id]/actions.ts). The form's action is that server action
// itself, so with JavaScript off the textarea and the two buttons post the
// form and the page comes back in its new state. Nothing here formats data,
// decides anything or calls a model; nothing is queued while offline.
import { Component, useActionState, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { ApprovalScreen, copy, type ApprovalRequest, type ApprovalState } from "@a2h/ui";
import type { ApprovalActionState } from "../../src/approval/decide";
import type { ApprovalPageModel } from "../../src/approval/page-data";

type Action = (prev: ApprovalActionState, form: FormData) => Promise<ApprovalActionState>;

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
  if (model.kind === "awaiting") return <Deciding {...props} request={model.request} />;
  const state: ApprovalState = model.kind;
  return (
    <>
      <title>{documentTitle(state)}</title>
      <ApprovalScreen
        state={state}
        {...shell(props)}
        {...("request" in model ? { request: model.request, decidedAt: model.decidedAt } : {})}
        {...(model.kind === "already-sent" ? { question: model.question } : {})}
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
function Deciding(props: ApprovalFormProps & { request: ApprovalRequest }) {
  const latest = useRef<string | undefined>(undefined);
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
      <Decision {...props} initial={initial} latest={latest} />
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

function Decision(props: ApprovalFormProps & { request: ApprovalRequest; initial: ApprovalActionState; latest: { current: string | undefined } }) {
  const { request, latest } = props;
  const [state, dispatch, pending] = useActionState(props.action, props.initial);
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
        question={outcome ? (questionOf(state) ?? question) : question}
        onQuestionChange={change}
        // The dispatch itself, not a wrapper: React then renders the server action's
        // hidden fields and the form posts with JavaScript off (D7).
        action={dispatch}
        {...shell(props)}
        {...("decidedAt" in state ? { decidedAt: state.decidedAt } : {})}
        {...(state.state === "refused" ? { refusal: state.refusal } : {})}
        {...(state.state === "error" && state.reference ? { reference: state.reference } : {})}
      />
    </div>
  );
}
