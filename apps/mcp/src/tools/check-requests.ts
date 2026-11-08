// check_requests (spec protocol/request-lifecycle "check_requests reports
// state and answer", "Identity revealed on acceptance only"; spec
// protocol/answer-attestation "What the principal sees"). Reads the calling
// principal's requests only. An answer is shown only after its signature
// verifies against its key (active or rotated, never revoked) over the
// canonical payload recomputed from the stored fields. Since m2-approval-page
// (task 3.2): while a request awaits approval, its link and the link's
// expiry; when it was not sent, why; before sending, no held amount.
import { findRequests, type RequestRecord, UNSENT_STATUSES } from "@a2h/db";
import {
  answerEnvelopeSchemaFor,
  approvalTokenHash,
  approvalUrl,
  deriveApprovalToken,
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
  code: "answer_unverified",
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

/** The approval link again, if the stage key still derives the token whose hash is stored (else left out). */
async function linkOf(r: RequestRecord, deps: ToolDeps): Promise<string | undefined> {
  if (r.approval_token_hash === null) return undefined;
  const token = await deriveApprovalToken(deps.approvalKey, r.id);
  return (await approvalTokenHash(token)) === r.approval_token_hash ? approvalUrl(deps.webOrigin, r.id, token) : undefined;
}

/** The statuses before a send (@a2h/db, one definition): no `sent_at`, no hold, the link while awaiting. */
const UNSENT = new Set<string>(UNSENT_STATUSES);

async function toChecked(r: RequestRecord, deps: ToolDeps): Promise<CheckedRequest | null> {
  const intent = IntentSchema.parse(r.intent);
  const at = (status: string) => r.events.find((e) => e.to_status === status)?.at.toISOString();
  const unsent = UNSENT.has(r.status);
  const transitions: CheckedRequest["transitions"] = {};
  for (const s of ["awaiting_approval", "not_sent", "sent", "accepted", "answered", "declined", "expired", "cancelled"] as const) {
    const when = at(s);
    if (when !== undefined) transitions[`${s}_at`] = when;
  }
  // Requests created before m2-approval-page were sent at creation.
  if (!unsent && transitions.sent_at === undefined) transitions.sent_at = r.created_at.toISOString();
  const accepted = transitions.accepted_at !== undefined;
  const paid = r.lane !== "free";
  const url = r.status === "awaiting_approval" ? await linkOf(r, deps) : undefined;
  const checked: CheckedRequest = {
    request_id: r.id,
    status: r.status,
    handle: r.participant.handle,
    // Identity is revealed on acceptance only.
    ...(accepted ? { participant_label: r.participant.display_label, identity_verified: r.participant.identity_verified } : {}),
    simulated: r.participant.simulated,
    intent,
    transitions,
    ...(unsent ? {} : { held_minor: paid ? r.bid_minor : 0 }),
    hold_status: holdStatusAfter(r.status, { paid }),
    currency: r.currency,
    ...(url ? { approval_url: url } : {}),
    ...(r.status === "awaiting_approval" && r.approval_expires_at ? { approval_expires_at: r.approval_expires_at.toISOString() } : {}),
    ...(r.status === "not_sent" && r.not_sent_reason ? { reason: r.not_sent_reason } : {}),
    // Type and size only, in the order attached (m2-attachments D8): never a name, a ref or a key.
    files: r.files,
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
  if (r.status === "awaiting_approval") {
    lines.push(
      r.approval_url
        ? `  Awaiting approval: nothing held or sent until the principal chooses Send on ${r.approval_url} (until ${r.approval_expires_at}).`
        : `  Awaiting approval until ${r.approval_expires_at}: nothing held or sent; the link can no longer be shown here (ask again with request_human for a new one).`,
    );
  }
  if (r.status === "not_sent") {
    lines.push(`  Not sent (${r.reason}): ${r.reason === "expired" ? "the approval link expired" : "the principal chose not to send it"}; nothing held, the participant was not contacted.`);
  }
  const steps = Object.entries(r.transitions).map(([k, v]) => `${k.replace(/_at$/, "")} ${v}`);
  lines.push(`  Steps: ${steps.join(" → ")}`);
  if (r.identity_verified !== undefined) lines.push(`  Identity: ${r.identity_verified ? "verified" : "not yet verified"}`);
  const hold =
    r.held_minor === undefined
      ? "nothing held"
      : r.hold_status === "none"
      ? "free lane, nothing held"
      : `${money(r.held_minor, r.currency)} ${r.hold_status === "held" ? "held" : r.hold_status === "released" ? "held, now released (nothing charged)" : "held"}`;
  lines.push(`  Money: ${hold}${r.cleared_minor !== undefined ? `; cleared ${money(r.cleared_minor, r.currency)}, the rest released` : ""}`);
  if (r.files.length > 0) lines.push(`  Files: ${r.files.length} attached by the principal (${r.files.map((f) => f.media_type).join(", ")}); their content is not available to agents.`);
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
