import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AuthShell, formActionProps, type AuthShellProps } from "../components/AuthShell.js";
import { DecisionBar } from "../components/DecisionBar.js";
import { Fact, FactList, FactNote, Mono, OptionList } from "../components/FactList.js";
import { fillNodes } from "../components/fillNodes.js";
import {
  FileAnnouncer,
  fileHint,
  FileList,
  filesFact,
  filesGate,
  gateText,
  type ApprovalFile,
  type ApprovalFileRules,
} from "../components/FileList.js";
import { FileUpload } from "../components/FileUpload.js";
import { LinkValidity } from "../components/LinkValidity.js";
import { LocalTime } from "../components/LocalTime.js";
import { Notice } from "../components/Notice.js";
import { QuestionEditor, questionStatus } from "../components/QuestionEditor.js";
import { StatusPill } from "../components/StatusPill.js";
import type { FormAction } from "../components/types.js";
import { copy, fill } from "./copy.js";
import styles from "./Screen.module.css";
import approval from "./ApprovalScreen.module.css";

/** Mirrors packages/protocol IntentSchema; the words are design copy. */
export type ApprovalIntent = keyof typeof copy.approval.intents;
/** Mirrors packages/protocol FormatSchema. */
export type ApprovalFormat = keyof typeof copy.approval.formats;
export type ApprovalFreeLane = keyof typeof copy.approval.freeLanes;

/**
 * Money, formatted at the edge by the app from minor units (skill §6). Gross to the principal;
 * the breakdown at the full bid uses the configured fee rate.
 */
export type ApprovalMoney =
  | { lane: "paid"; hold: string; feeRate: string; fee: string; net: string }
  | { lane: "free"; freeLane: ApprovalFreeLane };

/** What the page shows about one request, from the validated manifest and the participant row. */
export interface ApprovalRequest {
  /** "A2H-7f3c". */
  id: string;
  /** Display label (a simulated one ends with "(simulated)"), handle and the simulated flag. */
  participant: { label: string; handle: string; simulated: boolean };
  intent: ApprovalIntent;
  format: ApprovalFormat;
  /** Poll options verbatim, manifest order. */
  options?: ReadonlyArray<{ id: string; label: string }>;
  scale?: { min: number; max: number };
  money: ApprovalMoney;
  /** ISO with offset: the request's own expiry. */
  expiresAt: string;
  dataTerms: { attribution: keyof typeof copy.approval.attribution; training: keyof typeof copy.approval.training };
  /** ISO with offset when delivery would be deferred by the participant's rules; absent means now. */
  deliverAt?: string;
  /** The agent's question, byte for byte. */
  agentDraft: string;
  /** QUESTION_MAX_LENGTH from packages/protocol. */
  questionMaxLength: number;
  /** ISO with offset: when this approval link stops working. */
  approvalExpiresAt: string;
}

/** ProtocolError code (and content class where known) of a refused Send. */
export type ApprovalRefusal = keyof typeof copy.approval.refused;
/**
 * Send refused because a file was not ready when it was recorded (m2-attachments D4). Kept apart
 * from ApprovalRefusal, whose list the app maps one to one; the page accepts either.
 */
export type ApprovalFilesRefusal = "files_not_ready";

export type ApprovalState =
  | "awaiting"
  | "sending"
  | "not-sending"
  | "refused"
  | "error"
  | "offline"
  | "sent"
  | "already-sent"
  | "not-sent"
  | "already-not-sent"
  | "expired"
  | "wrong-principal";

export interface ApprovalScreenProps {
  state?: ApprovalState;
  /** Absent in "expired" and "wrong-principal": nothing about the request is shown there. */
  request?: ApprovalRequest;
  /** The current text (edited or not). Defaults to the agent draft. After a refusal, the edited text. */
  question?: string;
  onQuestionChange?: (value: string) => void;
  /** ISO: when the request was sent or refused ("sent", "already-sent", "already-not-sent"). */
  decidedAt?: string;
  refusal?: ApprovalRefusal | ApprovalFilesRefusal;
  /** Request id of the failed HTTP call, for the error notice. */
  reference?: string;
  /** Posts `question` and `decision` ("send" | "dont_send"). */
  action?: FormAction;
  email: string;
  signOutAction?: FormAction;
  stageName?: string;
  /**
   * ISO with offset: the clock at render, the server's. It decides whether "This link works
   * until …" is on the first paint (less than an hour left; design.md decision bar), so the
   * server and the hydrating browser agree. After hydration the browser's clock takes over.
   */
  now?: string;
  /** Fixed zone for stories and tests; pages leave it out and get the viewer's zone and clock. */
  timeZone?: string;

  // ---- Files (m2-attachments design.md, Screens F0–F12) ----
  /**
   * The request's files in the order the principal added them, with their states. Leave it out
   * only on a page that has no files feature; pass [] for a request without files.
   */
  files?: readonly ApprovalFile[];
  /** Allowed types and limits, from packages/protocol's constants. Required with `files`. */
  fileRules?: ApprovalFileRules;
  /** Files chosen, dropped or pasted. The app checks limits, adds rows and uploads. */
  onAddFiles?: (files: File[]) => void;
  /** Remove a file (any state; for an upload in progress, also abort it). */
  onRemoveFile?: (id: string) => void;
  /** Open a ready file: the app fetches a short-lived link and opens it in a new tab. */
  onOpenFile?: (id: string) => void;
}

/** /approve/[id] (m2-approval-page design.md, Screens A1–A12). */
export function ApprovalScreen(props: ApprovalScreenProps) {
  const { state = "awaiting", request, email, signOutAction, stageName } = props;
  const c = copy.approval;
  const shell = { account: { email, ...(signOutAction !== undefined ? { signOutAction } : {}) }, ...(stageName !== undefined ? { stageName } : {}) };
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  // Focus the heading when the page changes to an outcome after an action (not on first load).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (["sent", "not-sent", "already-sent", "already-not-sent", "expired"].includes(state)) heading.current?.focus();
  }, [state]);

  if (state === "wrong-principal") {
    return (
      <AuthShell {...shell} width="wide">
        <h1 className={styles.title} ref={heading} tabIndex={-1}>
          {c.wrongTitle}
        </h1>
        <p className={styles.lead}>{fillNodes(c.wrongBody, { address: <span className={styles.strong}>{email}</span> })}</p>
        <p className={styles.body}>{c.wrongAction}</p>
      </AuthShell>
    );
  }

  if (state === "expired" || request === undefined) {
    return (
      <AuthShell {...shell} width="wide">
        <h1 className={styles.title} ref={heading} tabIndex={-1}>
          {c.expiredTitle}
        </h1>
        <p className={styles.lead}>{c.expiredBody}</p>
        <p className={styles.body}>{c.expiredAgain}</p>
      </AuthShell>
    );
  }

  const time = (iso: string) => <LocalTime iso={iso} {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})} />;
  const question = props.question ?? request.agentDraft;
  const reference = (pill: ReactNode) => (
    <p className={approval.reference}>
      <Mono>{fill(c.reference, { id: request.id })}</Mono>
      {pill}
    </p>
  );

  if (state === "sent" || state === "already-sent") {
    const already = state === "already-sent";
    return (
      <AuthShell {...shell} width="wide">
        {reference(<StatusPill tone="success">{c.pillSent}</StatusPill>)}
        <h1 className={styles.title} ref={heading} tabIndex={-1}>
          {already ? c.alreadySentTitle : c.sentTitle}
        </h1>
        <div className={styles.tight}>
          <p className={styles.lead}>
            {fillNodes(c.sentAt, { participant: request.participant.label, time: props.decidedAt ? time(props.decidedAt) : "" })}
          </p>
          <p className={styles.body}>
            {request.money.lane === "paid" ? fillNodes(c.sentHeld, { amount: <span className={approval.money}>{request.money.hold}</span> }) : c.sentFree}
          </p>
          {already && <p className={styles.body}>{c.alreadyDecided}</p>}
          <p className={styles.body}>{c.sentCheck}</p>
        </div>
        <section className={styles.section} aria-labelledby="sent-question">
          <h2 className={styles.h2} id="sent-question">
            {c.sentQuestionHeading}
          </h2>
          <p className={approval.questionAsSent}>{question}</p>
        </section>
        {props.files !== undefined && props.files.length > 0 && (
          <section className={styles.section} aria-labelledby="sent-files">
            <h2 className={styles.h2} id="sent-files">
              {c.files.sentHeading}
            </h2>
            <FileList
              files={props.files}
              mode="read"
              aria-labelledby="sent-files"
              {...(props.onOpenFile !== undefined ? { onOpen: props.onOpenFile } : {})}
            />
          </section>
        )}
      </AuthShell>
    );
  }

  if (state === "not-sent" || state === "already-not-sent") {
    const already = state === "already-not-sent";
    return (
      <AuthShell {...shell} width="wide">
        {reference(<StatusPill tone="neutral">{c.pillNotSent}</StatusPill>)}
        <h1 className={styles.title} ref={heading} tabIndex={-1}>
          {already ? c.alreadyNotSentTitle : c.notSentTitle}
        </h1>
        {already ? (
          <>
            <p className={styles.lead}>{fillNodes(c.alreadyNotSentBody, { time: props.decidedAt ? time(props.decidedAt) : "" })}</p>
            <p className={styles.body}>{c.alreadyDecided}</p>
            <p className={styles.body}>{c.alreadyNotSentAgain}</p>
          </>
        ) : (
          <>
            <p className={styles.lead}>{fill(c.notSentBody, { participant: request.participant.label })}</p>
            {props.files !== undefined && props.files.length > 0 && <p className={styles.body}>{c.files.notSent}</p>}
            <p className={styles.body}>{c.notSentAgent}</p>
          </>
        )}
      </AuthShell>
    );
  }

  return (
    <AwaitingDecision
      state={state}
      request={request}
      question={question}
      time={time}
      shell={shell}
      {...(props.now !== undefined ? { now: props.now } : {})}
      {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})}
      {...(props.onQuestionChange !== undefined ? { onQuestionChange: props.onQuestionChange } : {})}
      {...(props.refusal !== undefined ? { refusal: props.refusal } : {})}
      {...(props.reference !== undefined ? { errorReference: props.reference } : {})}
      {...(props.action !== undefined ? { action: props.action } : {})}
      {...(props.files !== undefined ? { files: props.files } : {})}
      {...(props.fileRules !== undefined ? { fileRules: props.fileRules } : {})}
      {...(props.onAddFiles !== undefined ? { onAddFiles: props.onAddFiles } : {})}
      {...(props.onRemoveFile !== undefined ? { onRemoveFile: props.onRemoveFile } : {})}
      {...(props.onOpenFile !== undefined ? { onOpenFile: props.onOpenFile } : {})}
    />
  );
}

interface AwaitingDecisionProps {
  state: ApprovalState;
  request: ApprovalRequest;
  question: string;
  onQuestionChange?: (value: string) => void;
  refusal?: ApprovalRefusal | ApprovalFilesRefusal;
  errorReference?: string;
  action?: FormAction;
  time: (iso: string) => ReactNode;
  shell: Omit<AuthShellProps, "children">;
  now?: string;
  timeZone?: string;
  files?: readonly ApprovalFile[];
  fileRules?: ApprovalFileRules;
  onAddFiles?: (files: File[]) => void;
  onRemoveFile?: (id: string) => void;
  onOpenFile?: (id: string) => void;
}

function AwaitingDecision(props: AwaitingDecisionProps) {
  const { state, request, question: initial, onQuestionChange, refusal, errorReference, action, time, shell, now, timeZone, files, fileRules } = props;
  const c = copy.approval;
  const [own, setOwn] = useState(initial);
  const question = onQuestionChange ? initial : own;
  const setQuestion = (v: string) => (onQuestionChange ? onQuestionChange(v) : setOwn(v));
  const s = questionStatus(question, request.agentDraft, request.questionMaxLength);
  const errorId = useId();
  const gateId = useId();
  const gate = filesGate(files ?? []);
  const gateReason = gateText(gate);
  const sendBlockedBy = [!s.canSend ? errorId : null, gateReason !== undefined ? gateId : null].filter((x): x is string => x !== null).join(" ");
  const chooseRef = useRef<HTMLButtonElement>(null);
  const focusChoose = useCallback(() => chooseRef.current?.focus(), []);
  const unavailable = files !== undefined ? addUnavailable(state, files, fileRules) : undefined;
  const busy = state === "sending" || state === "not-sending";
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state === "refused" || state === "error") notice.current?.querySelector<HTMLElement>("[tabindex='-1']")?.focus();
  }, [state, refusal]);
  const m = request.money;

  return (
    <AuthShell {...shell} width="wide">
      <p className={approval.reference}>
        <Mono>{fill(c.reference, { id: request.id })}</Mono>
        <StatusPill tone="pending">{c.pillAwaiting}</StatusPill>
      </p>
      <h1 className={styles.title}>{c.title}</h1>
      <p className={styles.lead}>{fill(c.lead, { participant: request.participant.label })}</p>

      <div ref={notice} className={approval.notices}>
        {state === "refused" && refusal !== undefined && (
          <Notice tone="danger" title={refusedCopy(refusal, files).title} live="alert" focusable>
            <p>{refusedCopy(refusal, files).body}</p>
            <p>{c.refusedFooter}</p>
          </Notice>
        )}
        {state === "error" && (
          <Notice tone="danger" title={c.errorTitle} live="alert" focusable {...(errorReference !== undefined ? { reference: errorReference } : {})}>
            <p>{c.errorBody}</p>
          </Notice>
        )}
        {state === "offline" && (
          <Notice tone="neutral" title={c.offlineTitle} live="status">
            <p>{c.offlineBody}</p>
          </Notice>
        )}
      </div>

      <form className={styles.form} method="post" {...formActionProps(action)}>
        <QuestionEditor
          value={question}
          onChange={setQuestion}
          agentDraft={request.agentDraft}
          maxLength={request.questionMaxLength}
          isReadOnly={busy}
          errorId={errorId}
        />

        {files !== undefined && (
          <section className={styles.section} aria-labelledby="request-files">
            <h2 className={styles.h2} id="request-files">
              {c.attachmentsHeading}
            </h2>
            {fileRules !== undefined && (
              <p className={styles.muted}>
                {fileHint(fileRules)}
                {files.some((x) => x.state === "refused") && ` ${c.files.refusedNotCounted}`}
              </p>
            )}
            <FileList
              files={files}
              mode="edit"
              aria-labelledby="request-files"
              isDisabled={busy}
              onEmptied={focusChoose}
              {...(fileRules !== undefined ? { rules: fileRules } : {})}
              {...(props.onOpenFile !== undefined ? { onOpen: props.onOpenFile } : {})}
              {...(props.onRemoveFile !== undefined ? { onRemove: props.onRemoveFile } : {})}
            />
            <FileUpload
              accept={fileRules?.accept ?? []}
              buttonRef={chooseRef}
              isDisabled={busy || unavailable !== undefined}
              {...(unavailable !== undefined ? { disabledReason: unavailable } : {})}
              {...(props.onAddFiles !== undefined ? { onAddFiles: props.onAddFiles } : {})}
            />
            <FileAnnouncer files={files} {...(fileRules !== undefined ? { rules: fileRules } : {})} />
          </section>
        )}

        <section className={styles.section} aria-labelledby="request-details">
          <h2 className={styles.h2} id="request-details">
            {c.factsHeading}
          </h2>
          <FactList aria-labelledby="request-details">
            <Fact term={c.to}>
              <span>{request.participant.label}</span>
              <Mono>{request.participant.handle}</Mono>
              {request.participant.simulated && <FactNote>{c.simulatedNote}</FactNote>}
            </Fact>
            <Fact term={c.requestType}>{c.intents[request.intent]}</Fact>
            <Fact term={c.answerFormat}>
              <span>{c.formats[request.format]}</span>
              {request.options !== undefined && (
                <>
                  <FactNote>{c.optionsLead}</FactNote>
                  <OptionList options={request.options} />
                </>
              )}
              {request.scale !== undefined && <span>{fill(c.scale, { min: String(request.scale.min), max: String(request.scale.max) })}</span>}
            </Fact>
            {files !== undefined && (
              <Fact term={c.files.fact}>
                <span>{filesFact(files)}</span>
                {files.some((x) => x.state !== "refused") && <FactNote>{c.files.factNote}</FactNote>}
              </Fact>
            )}
            <Fact term={c.hold}>
              {m.lane === "paid" ? (
                <>
                  <span className={approval.money}>{fill(c.holdAmount, { amount: m.hold })}</span>
                  <FactNote>{c.holdTerms}</FactNote>
                  <FactNote>{fill(c.holdBreakdown, { rate: m.feeRate, net: m.net, fee: m.fee })}</FactNote>
                </>
              ) : (
                <span>{fill(c.holdFree, { topic: c.freeLanes[m.freeLane] })}</span>
              )}
            </Fact>
            <Fact term={c.expires}>
              <span>{time(request.expiresAt)}</span>
              <FactNote>{m.lane === "paid" ? c.expiresNote : c.expiresNoteFree}</FactNote>
            </Fact>
            <Fact term={c.dataTerms}>
              {fill(c.dataTermsText, { attribution: c.attribution[request.dataTerms.attribution], training: c.training[request.dataTerms.training] })}
            </Fact>
            <Fact term={c.delivery}>
              {request.deliverAt === undefined ? c.deliveryNow : <span>{fillNodes(c.deliveryDeferred, { time: time(request.deliverAt) })}</span>}
            </Fact>
          </FactList>
        </section>

        <DecisionBar
          sendLabel={m.lane === "paid" ? fill(c.sendPaid, { amount: m.hold }) : c.sendFree}
          sendPendingLabel={c.sendPending}
          dontSendLabel={c.dontSend}
          dontSendPendingLabel={c.dontSendPending}
          {...(state === "sending" ? { pending: "send" as const } : state === "not-sending" ? { pending: "dont-send" as const } : {})}
          sendDisabled={!s.canSend || !gate.canSend}
          {...(sendBlockedBy !== "" ? { sendDescribedBy: sendBlockedBy } : {})}
          {...(gateReason !== undefined ? { reason: gateReason, reasonId: gateId } : {})}
          note={
            <>
              {c.decisionNote}
              <LinkValidity until={request.approvalExpiresAt} {...(now !== undefined ? { now } : {})} {...(timeZone !== undefined ? { timeZone } : {})} />
            </>
          }
        />
      </form>
    </AuthShell>
  );
}

/** The refusal notice's words; "outside the participant's rules" says files may be the cause when there are any. */
function refusedCopy(refusal: ApprovalRefusal | ApprovalFilesRefusal, files: readonly ApprovalFile[] | undefined): { title: string; body: string } {
  if (refusal === "files_not_ready") return copy.approval.files.notReady;
  if (refusal === "outside_participant_rules" && files !== undefined && files.length > 0) return copy.approval.files.rulesWithFiles;
  return copy.approval.refused[refusal];
}

/** Why the upload control is unavailable, when the principal can do something about it. */
function addUnavailable(state: ApprovalState, files: readonly ApprovalFile[], rules?: ApprovalFileRules): string | undefined {
  const c = copy.approval.files;
  if (state === "offline") return c.offline;
  if (rules !== undefined && files.filter((x) => x.state !== "refused").length >= rules.maxFiles) return fill(c.full, { maxFiles: String(rules.maxFiles) });
  return undefined;
}
