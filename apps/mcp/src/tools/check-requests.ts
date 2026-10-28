// check_requests (spec protocol/request-lifecycle "check_requests reports
// state and answer", "Identity revealed on acceptance only"; spec
// protocol/answer-attestation "What the principal sees"). Reads the calling
// principal's requests only. An answer is shown only after its signature
// verifies against its key (active or rotated, never revoked) over the
// canonical payload recomputed from the stored fields.
import { findRequests, type RequestRecord } from "@a2h/db";
import {
  answerEnvelopeSchemaFor,
  type AnswerEnvelope,
  CheckRequestsInputSchema,
  type CheckRequestsOutput,
  type CheckedRequest,
  citation,
  clear,
  gross,
  holdStatusAfter,
  importPublicKey,
  type Intent,
  IntentSchema,
  type ProtocolError,
  signatureDisplay,
  verifiesWith,
  verifyAnswer,
} from "@a2h/protocol";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolLogFields } from "../logging.ts";
import { errorResult, money, parseArgs, type ToolDeps } from "./common.ts";

/** Page size when the filter names none. */
export const DEFAULT_LIMIT = 20;

export const VERIFICATION_NOTICE =
  "This participant is not yet identity-verified: they answered before completing identity verification, " +
  "which is required before any payout.";

type LogFields = Omit<ToolLogFields, "tool" | "http_request_id" | "principal_id" | "duration_ms">;

const NOT_FOUND: ProtocolError = { code: "not_found", stage: "lifecycle", retryable: false, detail: "No request with this id." };
const UNVERIFIED: ProtocolError = {
  code: "schema_invalid",
  stage: "lifecycle",
  retryable: false,
  detail: "The stored answer failed signature verification; it is not shown.",
};

function base64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

/** The envelope as stored, if it is complete, matches the intent and its signature verifies. */
async function verifiedEnvelope(r: RequestRecord, intent: Intent): Promise<AnswerEnvelope | null> {
  const a = r.answer;
  if (!a || !a.key || !verifiesWith(a.key.status)) return null;
  const parsed = answerEnvelopeSchemaFor(intent).safeParse({
    request_id: r.id,
    participant_id: a.participant_id,
    body: a.body,
    confidence: a.confidence,
    answered_personally: a.answered_personally,
    signed_at: a.signed_at,
    key_id: a.key_id,
    signature: a.signature,
  });
  if (!parsed.success || a.participant_id !== r.participant.participant_id) return null;
  try {
    return (await verifyAnswer(parsed.data, await importPublicKey(base64(a.key.public_key)))) ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The cleared amount the worker recorded; if absent, what the published rule clears at (reserve ≤ cleared ≤ bid). */
function clearedOf(r: RequestRecord, deps: ToolDeps): number {
  if (r.cleared_minor !== null) return r.cleared_minor;
  const reserve = r.reserve_net_minor === null ? r.bid_minor : Math.min(gross(r.reserve_net_minor, deps.policy.fee_rate), r.bid_minor);
  return clear(reserve, r.bid_minor, deps.clearingShare);
}

async function toChecked(r: RequestRecord, deps: ToolDeps): Promise<CheckedRequest | null> {
  const intent = IntentSchema.parse(r.intent);
  const at = (status: string) => r.events.find((e) => e.to_status === status)?.at.toISOString();
  const transitions: CheckedRequest["transitions"] = { sent_at: at("sent") ?? r.created_at.toISOString() };
  for (const s of ["accepted", "answered", "declined", "expired", "cancelled"] as const) {
    const when = at(s);
    if (when !== undefined) transitions[`${s}_at`] = when;
  }
  const accepted = transitions.accepted_at !== undefined;
  const paid = r.lane !== "free";
  const checked: CheckedRequest = {
    request_id: r.id,
    status: r.status,
    handle: r.participant.handle,
    // Identity is revealed on acceptance only.
    ...(accepted ? { participant_label: r.participant.display_label, identity_verified: r.participant.identity_verified } : {}),
    simulated: r.participant.simulated,
    intent,
    transitions,
    held_minor: paid ? r.bid_minor : 0,
    hold_status: holdStatusAfter(r.status, { paid }),
    currency: r.currency,
  };
  if (r.status !== "answered") return checked;

  const envelope = await verifiedEnvelope(r, intent);
  if (!envelope) return null;
  return {
    ...checked,
    cleared_minor: clearedOf(r, deps),
    answer: envelope,
    answer_display: {
      signature: signatureDisplay(envelope.signature),
      citation: citation(r.participant.display_label, envelope.signed_at),
      ...(r.participant.identity_verified ? {} : { verification_notice: VERIFICATION_NOTICE }),
    },
  };
}

function bodyLines(body: unknown, indent = "  "): string[] {
  if (body === null || typeof body !== "object") return [`${indent}${String(body)}`];
  const lines: string[] = [];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      lines.push(`${indent}${k}:`, ...bodyLines(v, `${indent}  `));
    } else {
      lines.push(`${indent}${k}: ${Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : String(v)}`);
    }
  }
  return lines;
}

function render(r: CheckedRequest): string {
  const who = r.participant_label ? `${r.handle} (${r.participant_label})` : `${r.handle}${r.simulated ? " (simulated)" : ""}`;
  const lines = [`${r.request_id} · ${r.status} · ${r.intent} · ${who}`];
  const steps = Object.entries(r.transitions).map(([k, v]) => `${k.replace(/_at$/, "")} ${v}`);
  lines.push(`  Steps: ${steps.join(" → ")}`);
  if (r.identity_verified !== undefined) lines.push(`  Identity: ${r.identity_verified ? "verified" : "not yet verified"}`);
  const hold =
    r.hold_status === "none"
      ? "free lane, nothing held"
      : `${money(r.held_minor, r.currency)} ${r.hold_status === "held" ? "held" : r.hold_status === "released" ? "held, now released (nothing charged)" : "held"}`;
  lines.push(`  Money: ${hold}${r.cleared_minor !== undefined ? `; cleared ${money(r.cleared_minor, r.currency)}, the rest released` : ""}`);
  if (r.answer && r.answer_display) {
    lines.push(`  Human answer from ${r.handle}${r.simulated ? " (simulated participant)" : ""}, answered personally: ${r.answer.answered_personally ? "yes" : "no"}`);
    lines.push(...bodyLines(r.answer.body, "    "));
    lines.push(`  Confidence: ${r.answer.confidence}/5`);
    lines.push(`  Signed ${r.answer.signed_at} · key ${r.answer.key_id} · ${r.answer_display.signature}`);
    lines.push(`  Cite as: ${r.answer_display.citation}`);
    if (r.answer_display.verification_notice) lines.push(`  Note: ${r.answer_display.verification_notice}`);
  }
  return lines.join("\n");
}

export async function checkRequests(deps: ToolDeps, args: unknown): Promise<{ result: CallToolResult; log: LogFields }> {
  const parsed = parseArgs(CheckRequestsInputSchema, args);
  if (!parsed.ok) return { result: errorResult(parsed.error), log: { outcome: "error", code: parsed.error.code } };
  const input = parsed.data;
  const principalId = deps.principal.principal_id;

  if (input.request_id !== undefined) {
    const [record] = await findRequests(deps.db, principalId, { request_id: input.request_id });
    // Unknown, or another principal's: the same answer, revealing nothing.
    if (!record) return { result: errorResult(NOT_FOUND), log: { outcome: "error", code: NOT_FOUND.code } };
    const checked = await toChecked(record, deps);
    if (!checked) {
      return { result: errorResult({ ...UNVERIFIED, request_id: record.id }), log: { outcome: "error", code: "answer_unverified", request_id: record.id, state: record.status } };
    }
    const out: CheckRequestsOutput = { requests: [checked] };
    return { result: { content: [{ type: "text", text: render(checked) }], structuredContent: out }, log: { outcome: "ok", request_id: record.id, state: record.status, participant_id: record.participant.participant_id, results: 1 } };
  }

  const records = await findRequests(deps.db, principalId, {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.since !== undefined ? { since: new Date(input.since) } : {}),
    limit: input.limit ?? DEFAULT_LIMIT,
  });
  const requests: CheckedRequest[] = [];
  let skipped = 0;
  for (const record of records) {
    const checked = await toChecked(record, deps);
    if (checked) requests.push(checked);
    else skipped++;
  }
  const out: CheckRequestsOutput = { requests };
  const text = requests.length
    ? [`${requests.length} request${requests.length === 1 ? "" : "s"}, newest first.`, ...requests.map(render)].join("\n")
    : "No requests match.";
  return {
    result: { content: [{ type: "text", text: skipped ? `${text}\n${skipped} answered request(s) left out: the stored answer failed signature verification.` : text }], structuredContent: out },
    log: { outcome: "ok", results: requests.length, ...(skipped ? { code: "answer_unverified" } : {}) },
  };
}
