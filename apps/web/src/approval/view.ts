// What the approval page shows about one request (m2-approval-page design.md
// Screens A0, "Data the web dev passes"), formatted at the edge from the
// stored request and its participant: money from minor units with the
// stage's fee rate (packages/protocol `fee`, `net`), times as ISO for
// `<time>`, words left to the UI's copy. Pure.
import {
  classifyForbiddenContent,
  fee,
  net,
  QUESTION_MAX_LENGTH,
  type ProtocolError,
} from "@a2h/protocol";
import { copy, type ApprovalRefusal, type ApprovalRequest } from "@a2h/ui";

const SYMBOL: Record<string, string> = { EUR: "€", GBP: "£", USD: "$" };

/** `€35.00` from 3500 EUR (two decimals for the v1 currencies); unknown currencies by code. */
export function formatMoney(minor: number, currency: string): string {
  const whole = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  const symbol = SYMBOL[currency];
  return symbol ? `${symbol}${whole}.${cents}` : `${whole}.${cents} ${currency}`;
}

/** `20%` from 0.2, read to the millionth as packages/protocol does. */
export function formatRate(rate: number): string {
  return `${Math.round(rate * 1_000_000) / 10_000}%`;
}

/** The stored request fields the page reads (packages/db `requests`). */
export interface StoredRequest {
  id: string;
  intent: string;
  format: string;
  lane: string;
  free_lane: string | null;
  agent_draft: string | null;
  question: string;
  options: unknown;
  scale: unknown;
  data_terms: unknown;
  bid_minor: number;
  currency: string;
  deliver_at: Date;
  expires_at: Date;
  approval_expires_at: Date | null;
}

export interface StoredParticipant {
  handle: string;
  display_label: string;
  simulated: boolean;
}

/** A textarea holds LF line breaks only (HTML's value normalisation): the field and its draft compare as the browser sees them. */
function asTextarea(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function approvalRequestView(r: StoredRequest, p: StoredParticipant, o: { feeRate: number; now: Date }): ApprovalRequest {
  const terms = r.data_terms as { attribution: ApprovalRequest["dataTerms"]["attribution"]; training: ApprovalRequest["dataTerms"]["training"] };
  const money: ApprovalRequest["money"] =
    r.lane === "free"
      ? { lane: "free", freeLane: r.free_lane as keyof typeof copy.approval.freeLanes }
      : {
          lane: "paid",
          hold: formatMoney(r.bid_minor, r.currency),
          feeRate: formatRate(o.feeRate),
          fee: formatMoney(fee(r.bid_minor, o.feeRate), r.currency),
          net: formatMoney(net(r.bid_minor, o.feeRate), r.currency),
        };
  const view: ApprovalRequest = {
    id: r.id,
    participant: { label: p.display_label, handle: p.handle, simulated: p.simulated },
    intent: r.intent as ApprovalRequest["intent"],
    format: r.format as ApprovalRequest["format"],
    money,
    expiresAt: r.expires_at.toISOString(),
    dataTerms: { attribution: terms.attribution, training: terms.training },
    agentDraft: asTextarea(r.agent_draft ?? r.question),
    questionMaxLength: QUESTION_MAX_LENGTH,
    approvalExpiresAt: (r.approval_expires_at ?? r.expires_at).toISOString(),
  };
  if (Array.isArray(r.options)) view.options = (r.options as Array<{ id: string; label: string }>).map((x) => ({ id: x.id, label: x.label }));
  if (r.scale !== null && typeof r.scale === "object") {
    const s = r.scale as { min: number; max: number };
    view.scale = { min: s.min, max: s.max };
  }
  if (r.deliver_at.getTime() > o.now.getTime()) view.deliverAt = r.deliver_at.toISOString();
  return view;
}

/**
 * The question as approved (spec "Accept after editing": byte-identical to
 * the edited text). Browsers post a textarea's line breaks as CR LF; the
 * field held LF, so LF is what was approved. Unchanged up to line breaks,
 * it is the agent's draft byte for byte.
 */
export function submittedQuestion(posted: unknown, agentDraft: string): string {
  if (typeof posted !== "string") return "";
  const text = asTextarea(posted);
  return text === asTextarea(agentDraft) ? agentDraft : text;
}

const WORDED = new Set<string>(Object.keys(copy.approval.refused));

/**
 * The wording of a refused Send (design.md A4): the error's code, or for
 * forbidden content the class the protocol's own rule finds in the edited
 * question (options cannot be edited, so a class found only there keeps the
 * generic wording). A code without wording: undefined (the error state).
 */
export function refusalOf(error: Pick<ProtocolError, "code">, question: string): ApprovalRefusal | undefined {
  if (error.code === "forbidden_content") return classifyForbiddenContent(question) ?? "forbidden_content";
  return WORDED.has(error.code) ? (error.code as ApprovalRefusal) : undefined;
}
