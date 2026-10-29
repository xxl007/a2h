// request_human (spec protocol/request-approval; design D1, D6, D7; owner
// decision 5, option 1). Nothing leaves the principal that the principal did
// not approve: the manifest is validated server side, then the principal is
// shown the exact question in a one-field form (2026-07-28 multi-round-trip
// `input_required`), and only an accept creates the request, byte-identical
// to the approved text, after a full re-validation. The pending approval is
// not stored anywhere: it travels as HMAC-signed state bound to the principal.
import {
  ApprovalAlreadyUsed,
  approvalNonceUsed,
  countDeliveries,
  createRequest,
  findPublishedParticipant,
  principalUsage,
  recordBlockedManifest,
  RequestIdTaken,
} from "@a2h/db";
import {
  type DataTerms,
  formatRequestId,
  type Manifest,
  manifestHash,
  type ProtocolError,
  RequestHumanInputSchema,
  type RequestHumanInput,
  type RequestHumanOutput,
  validateManifest,
  type ValidationFacts,
} from "@a2h/protocol";
import {
  CLIENT_CAPABILITIES_META_KEY,
  type CallToolResult,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { ToolLogFields } from "../logging.ts";
import { type ApprovalState, errorResult, money, parseArgs, type ToolDeps } from "./common.ts";

/** The key of the one input request (the approval form) in `inputRequests`. */
export const APPROVAL_INPUT = "approval";
/** The protocol revision whose multi-round-trip results carry the approval (D1). */
export const APPROVAL_REVISION = "2026-07-28";
/** How a Claude Code user selects that revision today (spike result, decision 5). */
export const CLAUDE_CODE_LAUNCH = "MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude";

export const OLD_REVISION_TEXT =
  `request_human needs MCP protocol revision ${APPROVAL_REVISION} to show you the question for approval, ` +
  "and this connection negotiated an earlier revision. Nothing was created and nothing was sent. " +
  `In Claude Code, quit and relaunch it with: ${CLAUDE_CODE_LAUNCH} ` +
  "(then call request_human again). Other clients: enable protocol revision 2026-07-28 with form elicitation.";

export const NO_FORMS_TEXT =
  "request_human needs a client that can show a form (elicitation) to ask the principal for approval, " +
  "and this client did not declare that capability. Nothing was created and nothing was sent.";

type LogFields = Omit<ToolLogFields, "tool" | "http_request_id" | "principal_id" | "duration_ms">;

export interface RequestHumanOutcome {
  result: CallToolResult | InputRequiredResult;
  log: LogFields;
}

const DAY_MS = 86_400_000;

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function envelopeOf(ctx: ServerContext): Record<string, unknown> {
  return (ctx.mcpReq.envelope ?? {});
}

/** True when the request rides the 2026-07-28 revision (or later), which carries `input_required`. */
function isModern(ctx: ServerContext): boolean {
  const version = envelopeOf(ctx)[PROTOCOL_VERSION_META_KEY];
  return typeof version === "string" && version >= APPROVAL_REVISION;
}

function canShowForms(ctx: ServerContext): boolean {
  const capabilities = envelopeOf(ctx)[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: { form?: unknown; url?: unknown } } | undefined;
  const elicitation = capabilities?.elicitation;
  if (elicitation === undefined) return false;
  // An empty `elicitation: {}` means form mode (the original elicitation).
  return elicitation.form !== undefined || elicitation.url === undefined;
}

function plain(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function refused(error: ProtocolError, participantId?: string): RequestHumanOutcome {
  return { result: errorResult(error), log: { outcome: "error", code: error.code, error_stage: error.stage, participant_id: participantId } };
}

const MISMATCH = "The approval does not match these arguments.";
const ALREADY_USED = "This approval was already used to send a request; nothing new was created. Ask again to send another.";

function conflict(participantId?: string, detail = MISMATCH): RequestHumanOutcome {
  return refused({ code: "conflict", stage: "principal", retryable: false, detail }, participantId);
}

const DATA_TERMS = {
  storage: { principal_workspace: "stored in the principal's workspace" },
  attribution: { attributed: "attributed to the participant", not_attributed: "not attributed" },
  training: { off: "never used for training", participant_opt_in: "used for training only if the participant opts in" },
} as const;

function dataTerms(t: DataTerms): string {
  return `${DATA_TERMS.storage[t.storage]}; ${DATA_TERMS.attribution[t.attribution]}; ${DATA_TERMS.training[t.training]}`;
}

function holdText(input: RequestHumanInput): string {
  return input.lane === "free" ? "Send (free lane, nothing held)" : `Send · hold ${money(input.bid_minor, input.currency)}`;
}

/**
 * The approval message: everything the participant will receive except the
 * question, which is the form's one field. Poll options and the scale are
 * listed verbatim (review B1): nothing reaches the participant that the
 * principal did not see. MCP form elicitation cannot label its buttons, so
 * the message ends with the consequence of accepting: "Send · hold €N".
 */
function approvalMessage(input: RequestHumanInput, simulated: boolean, deferred: boolean, deliverAt: string): string {
  const lines = [
    `Approve sending this question to ${input.to}${simulated ? " (a simulated participant)" : ""}? ` +
      "Edit the question if needed, then accept to send it exactly as written, or decline to send nothing.",
    `• Request type: ${input.intent} · Format: ${input.format.replaceAll("_", " ")} · Audience: ${input.audience.replaceAll("_", " ")}`,
  ];
  if (input.options) {
    lines.push(`• Poll options, sent exactly as written (the participant picks one):`);
    for (const o of input.options) lines.push(`    ${o.id}: ${o.label}`);
  }
  if (input.scale) lines.push(`• Scale: ${input.scale.min} to ${input.scale.max}`);
  lines.push(
    input.lane === "free"
      ? `• Free lane (${(input.free_lane ?? "").replaceAll("_", " ")}): nothing is held and nothing is charged.`
      : `• Bid: ${money(input.bid_minor, input.currency)} gross (platform fee included); the principal pays what clears, never more than the hold.`,
    `• Expires: ${input.expires_at} (if unanswered by then, the hold is released and nothing is charged)`,
    `• Data terms: ${dataTerms(input.data_terms)}`,
    `• Delivery: ${deferred ? `deferred to ${deliverAt} (the participant's quiet hours)` : "now"}`,
    `Decline = Don't send. Accept = ${holdText(input)}`,
  );
  return lines.join("\n");
}

/**
 * Shapes the protocol defines for later milestones (review B1, N1; spec
 * "Shape outside this change"). Refused here, at the mcp tool boundary, so
 * packages/protocol keeps them for M3 and the worker's validation is
 * unchanged: a request with one of them is never created.
 */
function outsideThisChange(input: RequestHumanInput): ProtocolError | null {
  const refuse = (field: string, why: string): ProtocolError => ({
    code: "schema_invalid",
    stage: "schema",
    retryable: false,
    detail: `Invalid field: ${field} (${why}; introduced in M3).`,
  });
  if (input.attachments !== undefined) return refuse("attachments", "attachments are not supported yet");
  if (input.audience !== "named_individual") return refuse("audience", "only named_individual for now");
  if (input.time_shape !== "one_shot") return refuse("time_shape", "only one_shot for now");
  return null;
}

async function loadFacts(
  deps: ToolDeps,
  participant: NonNullable<Awaited<ReturnType<typeof findPublishedParticipant>>>,
  now: Date,
  approval: ValidationFacts["approval"],
  binding?: ValidationFacts["approval_binding"],
): Promise<ValidationFacts> {
  const dayStart = utcDayStart(now);
  const [interruptions, usage] = await Promise.all([
    countDeliveries(deps.db, participant.participant_id, dayStart, new Date(dayStart.getTime() + DAY_MS)),
    principalUsage(deps.db, deps.principal.principal_id, utcMonthStart(now), dayStart),
  ]);
  return {
    now: now.toISOString(),
    principal: deps.principal,
    participant: { participant_id: participant.participant_id, handle: participant.handle, rules: participant.rules },
    interruptions_today: interruptions,
    budget: { used_minor: usage.committed_minor, currency: deps.policy.currency },
    requests_today: usage.requests_today,
    // No internal ratings exist before M6: nobody is throttled yet.
    principal_throttled: false,
    approval,
    ...(binding ? { approval_binding: binding } : {}),
  };
}

/** Validate; on a rules-stage failure, count the block for the participant (ids, code, time: never the question). */
async function validate(deps: ToolDeps, manifest: Manifest | Record<string, unknown>, facts: ValidationFacts) {
  const v = validateManifest(manifest, facts, deps.policy);
  if (!v.ok && v.blocked) await recordBlockedManifest(deps.db, v.blocked);
  return v;
}

async function create(deps: ToolDeps, manifest: Manifest, participantId: string, deliverAt: string, now: Date, nonce: string): Promise<string> {
  // Four hex characters (spec "Identifier formats"): draw again on a collision.
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = formatRequestId(deps.randomBytes(2));
    try {
      await createRequest(deps.db, { id, approval_nonce: nonce, manifest, participant_id: participantId, deliver_at: new Date(deliverAt), now });
      return id;
    } catch (error) {
      if (!(error instanceof RequestIdTaken)) throw error;
    }
  }
  throw new Error("no free request id after 32 attempts");
}

function sentText(out: RequestHumanOutput, input: RequestHumanInput, simulated: boolean): string {
  const lines = [
    `Sent ${out.request_id} to ${input.to}${simulated ? " (simulated participant)" : ""}, status sent.`,
    input.lane === "free"
      ? "Free lane: nothing is held."
      : `Held ${money(out.held_minor ?? 0, input.currency)}: the principal pays what clears, never more than the hold.`,
    out.deferred
      ? `Delivery deferred to ${out.deliver_at} (outside the participant's quiet hours); expected answer by ${out.eta}.`
      : `Delivered now; expected answer by ${out.eta} (the participant's latency promise).`,
    `The session may end: check later with check_requests { "request_id": "${out.request_id}" }.`,
  ];
  return lines.join("\n");
}

export async function requestHuman(deps: ToolDeps, args: unknown, ctx: ServerContext): Promise<RequestHumanOutcome> {
  // Decision 5, option 1: a 2025-era connection cannot carry the approval on
  // a stateless server; say how to connect, create nothing, count nothing.
  if (!isModern(ctx)) return { result: plain(OLD_REVISION_TEXT), log: { outcome: "error", code: "old_revision" } };
  if (!canShowForms(ctx)) return { result: plain(NO_FORMS_TEXT), log: { outcome: "error", code: "no_elicitation" } };

  const parsed = parseArgs(RequestHumanInputSchema, args);
  if (!parsed.ok) return refused(parsed.error);
  const input = parsed.data;
  const outside = outsideThisChange(input);
  if (outside) return refused(outside);
  const now = deps.now();

  const participant = await findPublishedParticipant(deps.db, input.to);
  if (!participant) {
    return refused({ code: "not_found", stage: "schema", retryable: false, detail: "No published participant has this handle." });
  }
  const pid = participant.participant_id;
  const responses = ctx.mcpReq.inputResponses;

  // ---- first round: validate, then ask ------------------------------------
  if (responses === undefined) {
    const v = await validate(deps, { ...input, principal_id: deps.principal.principal_id }, await loadFacts(deps, participant, now, "pending"));
    if (!v.ok) return refused(v.error, pid);
    const state: ApprovalState = {
      principal_id: deps.principal.principal_id,
      manifest_hash: await manifestHash(input),
      nonce: Buffer.from(deps.randomBytes(16)).toString("hex"),
      issued_at: now.toISOString(),
    };
    const result = inputRequired({
      inputRequests: {
        [APPROVAL_INPUT]: inputRequired.elicit({
          mode: "form",
          message: approvalMessage(input, participant.simulated, v.deferred, v.deliver_at),
          requestedSchema: {
            type: "object",
            properties: {
              question: { type: "string", title: "Question (sent exactly as written)", default: input.question, minLength: 1, maxLength: 2000 },
            },
            required: ["question"],
          },
        }),
      },
      requestState: await deps.codec.mint(state, ctx),
    });
    return { result, log: { outcome: "input_required", participant_id: pid } };
  }

  // ---- retry: the state was verified by the SDK hook before we got here ----
  const state = ctx.mcpReq.requestState<ApprovalState>();
  if (state === undefined || state.principal_id !== deps.principal.principal_id) return conflict(pid);
  const presented = await manifestHash(input);
  if (state.manifest_hash !== presented) return conflict(pid);
  // An accepted approval creates one request only (spec "Accepted approval
  // replayed"): a state whose nonce already created a request is refused here,
  // before re-validation, so a replay counts nothing; the unique index on
  // requests.approval_nonce settles concurrent retries.
  if (await approvalNonceUsed(deps.db, state.nonce)) return conflict(pid, ALREADY_USED);

  const answer = inputResponse(responses, APPROVAL_INPUT);
  if (answer.kind !== "elicit") return conflict(pid);
  if (answer.action !== "accept") {
    const reason = answer.action === "decline" ? "declined" : "dismissed";
    const out: RequestHumanOutput = { status: "not_sent", reason };
    const text = `Not sent: the principal ${reason === "declined" ? "declined" : "dismissed the approval"}. Nothing was created and nothing was sent.`;
    return { result: { content: [{ type: "text", text }], structuredContent: out }, log: { outcome: "not_sent", code: reason, participant_id: pid } };
  }

  // The approved text replaces the draft; everything else is bound by the hash.
  const manifest = { ...input, question: answer.content?.["question"], principal_id: deps.principal.principal_id };
  const v = await validate(deps, manifest, await loadFacts(deps, participant, now, "recorded", { issued_for: state.manifest_hash, presented }));
  if (!v.ok) return refused(v.error, pid);

  let id: string;
  try {
    id = await create(deps, manifest as Manifest, pid, v.deliver_at, now, state.nonce);
  } catch (error) {
    if (error instanceof ApprovalAlreadyUsed) return conflict(pid, ALREADY_USED);
    throw error;
  }
  const out: RequestHumanOutput = {
    status: "sent",
    request_id: id,
    eta: v.eta,
    held_minor: input.bid_minor,
    currency: input.currency,
    deliver_at: v.deliver_at,
    deferred: v.deferred,
  };
  return {
    result: { content: [{ type: "text", text: sentText(out, input, participant.simulated) }], structuredContent: out },
    log: { outcome: "ok", request_id: id, participant_id: pid, state: "sent" },
  };
}
