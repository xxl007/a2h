// What /approve/[id] shows for a link (m2-approval-page design D2, D7;
// design.md A1, A8, A10, A11). Read-only. The order is the spec's: the
// token is checked first, so a wrong token never confirms that an id exists
// or whose it is ("Forged token": the same answer as an expired link); then
// the principal ("Wrong principal": nothing about the request); then the
// request's state. A link past its expiry shows as expired before the
// worker's minute job moves the request (D6).
import { approvalTokenHash, ApprovalTokenSchema } from "@a2h/protocol";
import { and, eq, listRequestFiles, participants, requestEvents, requests, type A2hDb } from "@a2h/db";
import type { ApprovalFile, ApprovalRequest } from "@a2h/ui";
import { approvalFileOf } from "./files";
import { approvalRequestView } from "./view";

export type ApprovalPageModel =
  | { kind: "expired" }
  | { kind: "wrong-principal" }
  /** `now`: the server's clock at render (ISO), the first paint of the link validity line (design.md decision bar). */
  | { kind: "awaiting"; request: ApprovalRequest; now: string; files: ApprovalFile[] }
  /** `files`: the request's files in the order added (m2-attachments design.md F0, F13); [] without files. */
  | { kind: "already-sent"; request: ApprovalRequest; question: string; decidedAt: string; files: ApprovalFile[] }
  | { kind: "already-not-sent"; request: ApprovalRequest; decidedAt: string };

export interface ApprovalPageQuery {
  requestId: string;
  /** From the page's cookie (src/approval/link.ts); absent means no link was opened in this browser. */
  token: string | undefined;
  /** The signed-in session's principal (allow-list re-checked by the session read). */
  principalId: string;
  now: Date;
  feeRate: number;
}

const EXPIRED = { kind: "expired" } as const;

/** When the principal decided: the event that left `awaiting_approval`. */
export async function decidedAt(db: A2hDb, requestId: string, fallback: Date): Promise<string> {
  const [e] = await db
    .select({ at: requestEvents.at })
    .from(requestEvents)
    .where(and(eq(requestEvents.request_id, requestId), eq(requestEvents.from_status, "awaiting_approval")));
  return (e?.at ?? fallback).toISOString();
}

export async function loadApprovalPage(db: A2hDb, q: ApprovalPageQuery): Promise<ApprovalPageModel> {
  if (q.token === undefined || !ApprovalTokenSchema.safeParse(q.token).success) return EXPIRED;
  const presented = await approvalTokenHash(q.token);
  const [found] = await db
    .select({ request: requests, participant: { handle: participants.handle, display_label: participants.display_label, simulated: participants.simulated } })
    .from(requests)
    .innerJoin(participants, eq(participants.id, requests.participant_id))
    .where(eq(requests.id, q.requestId));
  if (!found || found.request.approval_token_hash === null || found.request.approval_token_hash !== presented) return EXPIRED;
  const r = found.request;
  if (r.principal_id !== q.principalId) return { kind: "wrong-principal" };

  if (r.status === "awaiting_approval") {
    if (r.approval_expires_at === null || r.approval_expires_at.getTime() <= q.now.getTime()) return EXPIRED;
    const files = (await listRequestFiles(db, r.id)).map(approvalFileOf);
    return { kind: "awaiting", request: approvalRequestView(r, found.participant, q), now: q.now.toISOString(), files };
  }
  if (r.status === "not_sent") {
    if (r.not_sent_reason !== "declined") return EXPIRED;
    return { kind: "already-not-sent", request: approvalRequestView(r, found.participant, q), decidedAt: await decidedAt(db, r.id, r.updated_at) };
  }
  // Sent, and whatever happened since (accepted, answered, expired after sending…): it left on this page.
  const files = (await listRequestFiles(db, r.id)).map(approvalFileOf);
  return {
    kind: "already-sent",
    request: approvalRequestView(r, found.participant, q),
    question: r.question,
    decidedAt: await decidedAt(db, r.id, r.updated_at),
    files,
  };
}
