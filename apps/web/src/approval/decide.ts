// Send and Don't send on the approval page (m2-approval-page design D4; spec
// platform/approval-page, protocol/request-approval). One call to
// packages/db `decideApproval`, which locks the request, checks the token,
// the principal, the state and the link's expiry, re-validates the manifest
// with the approved question through the shared loaders and moves it, in one
// transaction. Every outcome maps to one state of the page (design.md A3-A11).
// Logs carry the request id, the principal id and a code; never the token,
// the question or a participant's detail.
import { decideApproval, eq, requests, type A2hDb } from "@a2h/db";
import type { ApprovalRefusal } from "@a2h/ui";
import { errorFields, type Logger } from "../log";
import { decidedAt } from "./page-data";
import { refusalOf, submittedQuestion } from "./view";

export type ApprovalActionState =
  | { state: "awaiting" }
  | { state: "refused"; refusal: ApprovalRefusal; question: string }
  | { state: "error"; reference: string; question?: string }
  | { state: "sent"; decidedAt: string; question: string }
  | { state: "not-sent" }
  | { state: "already-sent"; decidedAt: string; question: string }
  | { state: "already-not-sent"; decidedAt: string }
  | { state: "expired" }
  | { state: "wrong-principal" };

export interface DecideDeps {
  db: A2hDb;
  feeRate: number;
  logger: Logger;
  now?: () => Date;
}

export interface DecideInput {
  requestId: string;
  /** From the page's cookie; absent: no link was opened in this browser. */
  token: string | undefined;
  /** The signed-in session's principal. */
  principalId: string;
  /** `decision` ("send" | "dont_send") and `question`. */
  form: FormData;
  /** Correlation id of this call, shown on the error state. */
  reference: string;
}

export async function decide(deps: DecideDeps, i: DecideInput): Promise<ApprovalActionState> {
  const now = deps.now?.() ?? new Date();
  const fields = { request_id: i.requestId, principal_id: i.principalId };
  const decision = i.form.get("decision");
  const posted = i.form.get("question");
  const kept = typeof posted === "string" ? posted.replace(/\r\n?/g, "\n") : undefined;
  if (decision !== "send" && decision !== "dont_send") {
    deps.logger.warn("approval decision refused: unknown decision", { ...fields, code: "approval_bad_decision" });
    return { state: "error", reference: i.reference, ...(kept !== undefined ? { question: kept } : {}) };
  }
  if (i.token === undefined) return { state: "expired" };

  try {
    let question = "";
    if (decision === "send") {
      // Unchanged up to the browser's line breaks: the agent's draft byte for byte.
      const [draft] = await deps.db.select({ agent_draft: requests.agent_draft, question: requests.question }).from(requests).where(eq(requests.id, i.requestId));
      question = submittedQuestion(posted, draft?.agent_draft ?? draft?.question ?? "");
    }
    const outcome = await decideApproval(deps.db, {
      request_id: i.requestId,
      token: i.token,
      principal_id: i.principalId,
      now,
      fee_rate: deps.feeRate,
      decision: decision === "send" ? { kind: "send", question } : { kind: "dont_send" },
    });
    deps.logger.info("approval decision", { ...fields, code: `approval_${outcome.kind}` });
    switch (outcome.kind) {
      case "sent":
        return { state: "sent", decidedAt: now.toISOString(), question };
      case "not_sent":
        return { state: "not-sent" };
      case "invalid": {
        const refusal = refusalOf(outcome.error, question);
        if (refusal === undefined) {
          deps.logger.warn("approval send refused without wording", { ...fields, code: outcome.error.code });
          return { state: "error", reference: i.reference, question };
        }
        return { state: "refused", refusal, question };
      }
      case "already_decided": {
        if (outcome.status === "not_sent") return { state: "already-not-sent", decidedAt: outcome.decided_at };
        const [r] = await deps.db.select({ question: requests.question, updated_at: requests.updated_at }).from(requests).where(eq(requests.id, i.requestId));
        return { state: "already-sent", decidedAt: outcome.decided_at ?? (await decidedAt(deps.db, i.requestId, r!.updated_at)), question: r!.question };
      }
      case "expired":
      case "link_invalid":
        return { state: "expired" };
      case "wrong_principal":
        return { state: "wrong-principal" };
    }
  } catch (e) {
    deps.logger.error(`approval decision not recorded for ${i.requestId}`, { request_id: i.reference, principal_id: i.principalId, ...errorFields(e) });
    return { state: "error", reference: i.reference, ...(kept !== undefined ? { question: kept } : {}) };
  }
}
