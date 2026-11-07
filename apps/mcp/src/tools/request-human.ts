// request_human (m2-approval-page, design D1-D3, D5; spec
// protocol/request-approval). Nothing leaves the principal that the principal
// did not approve: the manifest is validated server side, then recorded as
// `awaiting_approval` (nothing held, nothing delivered) and the principal
// decides on the hosted approval page, the only place a request becomes
// `sent`. The link is offered through a 2026-07-28 URL elicitation where the
// client declares `elicitation.url`, and in the result text everywhere else.
// The server keeps no session state: the elicitation's `requestState` carries
// the request id, signed and bound to the principal (D3).
import {
  approvalFacts,
  createAwaitingRequest,
  decideApproval,
  findPublishedParticipant,
  findRequests,
  recordBlockedManifest,
  RequestIdTaken,
} from "@a2h/db";
import {
  approvalLinkExpiry,
  approvalTokenHash,
  approvalUrl,
  deriveApprovalToken,
  formatRequestId,
  type Manifest,
  type ProtocolError,
  RequestHumanInputSchema,
  type RequestHumanInput,
  type RequestHumanOutput,
  validateManifest,
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

/** The key of the one input request (the URL elicitation) in `inputRequests`. */
export const APPROVAL_INPUT = "approval";
/** The protocol revision whose multi-round-trip results carry URL elicitation (D3). */
export const URL_ELICITATION_REVISION = "2026-07-28";
/** The one-sentence message of the URL elicitation (spec "Client with URL elicitation"). */
export const URL_ELICITATION_MESSAGE = "Open the A2H approval page to review this request, edit it if needed, and send it or not.";

type LogFields = Omit<ToolLogFields, "tool" | "http_request_id" | "principal_id" | "duration_ms">;

export interface RequestHumanOutcome {
  result: CallToolResult | InputRequiredResult;
  log: LogFields;
}

function envelopeOf(ctx: ServerContext): Record<string, unknown> {
  return ctx.mcpReq.envelope ?? {};
}

/** True when the client rides 2026-07-28 (or later) and declared URL elicitation. */
function offersUrlElicitation(ctx: ServerContext): boolean {
  const env = envelopeOf(ctx);
  const version = env[PROTOCOL_VERSION_META_KEY];
  const capabilities = env[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: { url?: unknown } } | undefined;
  return typeof version === "string" && version >= URL_ELICITATION_REVISION && capabilities?.elicitation?.url !== undefined;
}

function refused(error: ProtocolError, participantId?: string): RequestHumanOutcome {
  return { result: errorResult(error), log: { outcome: "error", code: error.code, error_stage: error.stage, participant_id: participantId } };
}

const NO_STATE: ProtocolError = {
  code: "conflict",
  stage: "principal",
  retryable: false,
  detail: "This answer does not belong to an approval link this server issued. Call request_human again without inputResponses.",
};

/**
 * Shapes the protocol defines for later milestones (review B1, N1; spec
 * "Shape outside this change"). Refused here, at the mcp tool boundary, so a
 * request with one of them is never recorded.
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

interface Awaiting {
  request_id: string;
  approval_url: string;
  approval_expires_at: string;
}

function awaitingText(a: Awaiting, input: Pick<RequestHumanInput, "to" | "lane" | "bid_minor" | "currency"> | null): string {
  const lines = [
    `Show the principal this approval link and ask them to open it: ${a.approval_url}`,
    `Request ${a.request_id}${input ? ` to ${input.to}` : ""} is awaiting approval: nothing is held and nothing is sent until the principal chooses Send on that page.`,
  ];
  if (input) {
    lines.push(
      input.lane === "free"
        ? "Free lane: nothing will be held."
        : `On Send, ${money(input.bid_minor, input.currency)} is held: the principal pays what clears, never more than the hold.`,
    );
  }
  lines.push(
    `The link works until ${a.approval_expires_at}, only for the principal, signed in; after that the request is not sent.`,
    `Follow it with check_requests { "request_id": "${a.request_id}" }: it reports awaiting_approval, then sent or not_sent.`,
  );
  return lines.join("\n");
}

function awaitingResult(a: Awaiting, input: Pick<RequestHumanInput, "to" | "lane" | "bid_minor" | "currency"> | null): CallToolResult {
  const out: RequestHumanOutput = { status: "awaiting_approval", ...a };
  return { content: [{ type: "text", text: awaitingText(a, input) }], structuredContent: out };
}

async function linkOf(deps: ToolDeps, requestId: string): Promise<{ token: string; url: string }> {
  const token = await deriveApprovalToken(deps.approvalKey, requestId);
  return { token, url: approvalUrl(deps.webOrigin, requestId, token) };
}

/** Record the validated manifest as awaiting approval under a fresh id (four hex characters: draw again on a collision). */
async function record(deps: ToolDeps, manifest: Manifest, participantId: string, deliverAt: string, expiresAt: string, now: Date): Promise<Awaiting> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = formatRequestId(deps.randomBytes(2));
    const { token, url } = await linkOf(deps, id);
    try {
      await createAwaitingRequest(deps.db, {
        id,
        manifest,
        participant_id: participantId,
        deliver_at: new Date(deliverAt),
        approval_token_hash: await approvalTokenHash(token),
        approval_expires_at: new Date(expiresAt),
        now,
      });
      return { request_id: id, approval_url: url, approval_expires_at: expiresAt };
    } catch (error) {
      if (!(error instanceof RequestIdTaken)) throw error;
    }
  }
  throw new Error("no free request id after 32 attempts");
}

/**
 * The retry of the URL elicitation (D3): accept or no answer → the awaiting
 * result again; decline or cancel → Don't send by the principal, through the
 * same decision transaction as the page. The request comes from the signed
 * state, never from the arguments: a retry records nothing new.
 */
async function retried(deps: ToolDeps, ctx: ServerContext): Promise<RequestHumanOutcome> {
  const state = ctx.mcpReq.requestState<ApprovalState>();
  if (state === undefined) return refused(NO_STATE);
  const [record] = await findRequests(deps.db, deps.principal.principal_id, { request_id: state.request_id });
  if (!record) return refused(NO_STATE);
  const pid = record.participant.participant_id;
  const ids = { request_id: record.id, participant_id: pid };
  const { token, url } = await linkOf(deps, record.id);
  const answer = inputResponse(ctx.mcpReq.inputResponses, APPROVAL_INPUT);
  const refusedToOpen = answer.kind === "elicit" && (answer.action === "decline" || answer.action === "cancel");

  if (!refusedToOpen) {
    if (record.status !== "awaiting_approval" || !record.approval_expires_at) {
      return refused({ code: "conflict", stage: "lifecycle", retryable: false, request_id: record.id, detail: "This request was already decided on its approval page; check_requests reports it." }, pid);
    }
    const a = { request_id: record.id, approval_url: url, approval_expires_at: record.approval_expires_at.toISOString() };
    return { result: awaitingResult(a, null), log: { outcome: "ok", state: "awaiting_approval", ...ids } };
  }

  const decided = await decideApproval(deps.db, {
    request_id: record.id,
    token,
    principal_id: deps.principal.principal_id,
    now: deps.now(),
    fee_rate: deps.policy.fee_rate,
    decision: { kind: "dont_send" },
  });
  if (decided.kind !== "not_sent" && !(decided.kind === "already_decided" && decided.status === "not_sent")) {
    return refused({ code: "conflict", stage: "lifecycle", retryable: false, request_id: record.id, detail: "This request was already decided on its approval page; check_requests reports it." }, pid);
  }
  const out: RequestHumanOutput = { status: "not_sent", request_id: record.id, reason: "declined" };
  const text = `Request ${record.id} was not sent: the principal declined to open the approval page. Nothing was held or sent, and the participant was not contacted.`;
  return { result: { content: [{ type: "text", text }], structuredContent: out }, log: { outcome: "not_sent", code: "declined", state: "not_sent", ...ids } };
}

export async function requestHuman(deps: ToolDeps, args: unknown, ctx: ServerContext): Promise<RequestHumanOutcome> {
  if (ctx.mcpReq.inputResponses !== undefined) return retried(deps, ctx);

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

  const manifest = { ...input, principal_id: deps.principal.principal_id };
  const facts = await approvalFacts(deps.db, { principal: deps.principal, currency: deps.policy.currency, participant, now, approval: "pending" });
  const v = validateManifest(manifest, facts, deps.policy);
  if (!v.ok) {
    // A rules-stage refusal is counted for the participant (ids, code, time: never the question).
    if (v.blocked) await recordBlockedManifest(deps.db, v.blocked);
    return refused(v.error, pid);
  }
  // validateManifest has refused (latency) whenever the link would last under 15 minutes.
  const expiresAt = approvalLinkExpiry({ now: now.toISOString(), expires_at: input.expires_at, latency_promise_seconds: participant.rules.latency_promise_seconds })!;
  const a = await record(deps, manifest, pid, v.deliver_at, expiresAt, now);
  const ids = { request_id: a.request_id, participant_id: pid, state: "awaiting_approval" };

  if (offersUrlElicitation(ctx)) {
    const result = inputRequired({
      inputRequests: { [APPROVAL_INPUT]: inputRequired.elicitUrl({ message: URL_ELICITATION_MESSAGE, url: a.approval_url }) },
      requestState: await deps.codec.mint({ request_id: a.request_id }, ctx),
    });
    return { result, log: { outcome: "input_required", ...ids } };
  }
  return { result: awaitingResult(a, input), log: { outcome: "ok", ...ids } };
}
