// The awaiting-approval request and its decision (m2-approval-page design
// D1, D4, D6), shared by apps/mcp (`request_human` records the request),
// apps/web (the approval page decides it) and apps/worker (expiry). Typed
// over any Drizzle Postgres database, so the same code runs on node-postgres
// and on the Data API driver. The validation is the protocol's pure
// `validateManifest`, fed by the shared loaders below, so the page and the
// tool cannot drift.
import {
  approvalTokenHash,
  ApprovalTokenSchema,
  type Manifest,
  type NotSentReason,
  type Principal,
  type ProtocolError,
  type RequestStatus,
  type RulesOfEngagement,
  transition,
  validateManifest,
  type ValidationFacts,
} from "@a2h/protocol";
import { and, asc, eq, lte } from "drizzle-orm";
import { participants, requestEvents, requests, rules, ruleTypes } from "../schema.ts";
import {
  type A2hDb,
  countDeliveries,
  isUniqueViolation,
  principalUsage,
  type PublishedParticipant,
  recordBlockedManifest,
  RequestIdTaken,
} from "./mcp.ts";
import { principalWithPolicy } from "./principals.ts";

const DAY_MS = 86_400_000;

export type RequestRow = typeof requests.$inferSelect;

// ---- shared loaders ---------------------------------------------------------

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * The validation facts of the approval phase (`request_human` and Send on
 * the page): the participant's current rules, today's sent requests to them
 * (deferred ones included), the principal's committed budget this month and
 * requests sent today. Requests awaiting approval or not sent count for
 * nothing, the one being decided included.
 */
export async function approvalFacts(
  db: A2hDb,
  i: { principal: Principal; currency: string; participant: Pick<PublishedParticipant, "participant_id" | "handle" | "rules">; now: Date; approval: ValidationFacts["approval"] },
): Promise<ValidationFacts> {
  const dayStart = utcDayStart(i.now);
  // One after the other, never Promise.all: `decideApproval` passes its
  // transaction, and the Aurora Data API refuses a second statement on a
  // transaction while one is running ("Transaction is still running a query",
  // pr-82). node-postgres would queue them silently.
  const interruptions = await countDeliveries(db, i.participant.participant_id, dayStart, new Date(dayStart.getTime() + DAY_MS));
  const usage = await principalUsage(db, i.principal.principal_id, utcMonthStart(i.now), dayStart);
  return {
    now: i.now.toISOString(),
    principal: i.principal,
    participant: { participant_id: i.participant.participant_id, handle: i.participant.handle, rules: i.participant.rules },
    interruptions_today: interruptions,
    budget: { used_minor: usage.committed_minor, currency: i.currency },
    requests_today: usage.requests_today,
    // No internal ratings exist before M6: nobody is throttled yet.
    principal_throttled: false,
    approval: i.approval,
  };
}

/** Rules that accept nothing: what a participant without published rules has (fails closed). */
export const NO_RULES: RulesOfEngagement = {
  types: [],
  free_lanes: [],
  who_may_ask: "organisations_only",
  quiet_hours: null,
  max_interruptions_per_day: 0,
  latency_promise_seconds: 0,
};

/** The participant's rules as published now; without any, NO_RULES. */
export async function currentRules(db: A2hDb, participantId: string): Promise<RulesOfEngagement> {
  const [r] = await db.select().from(rules).where(eq(rules.participant_id, participantId));
  if (!r) return NO_RULES;
  const types = await db.select().from(ruleTypes).where(eq(ruleTypes.participant_id, participantId));
  return {
    types: types.map((t) => ({ intent: t.intent, accepted: t.accepted, reserve_net_minor: t.reserve_net_minor, currency: t.currency })),
    free_lanes: r.free_lanes,
    who_may_ask: r.who_may_ask,
    quiet_hours: r.quiet_start && r.quiet_end && r.quiet_time_zone ? { start: r.quiet_start, end: r.quiet_end, time_zone: r.quiet_time_zone } : null,
    max_interruptions_per_day: r.max_interruptions_per_day,
    latency_promise_seconds: r.latency_promise_seconds,
  } as RulesOfEngagement;
}

/** The manifest of a stored request, as delivered (checked again by validateManifest's schema stage). */
export function manifestOfRequest(r: RequestRow, handle: string): Manifest {
  const m: Record<string, unknown> = {
    to: handle,
    intent: r.intent,
    audience: r.audience,
    time_shape: r.time_shape,
    format: r.format,
    question: r.question,
    lane: r.lane,
    bid_minor: r.bid_minor,
    currency: r.currency,
    expires_at: r.expires_at.toISOString(),
    data_terms: r.data_terms,
    principal_id: r.principal_id,
  };
  if (r.free_lane !== null) m["free_lane"] = r.free_lane;
  if (r.options !== null) m["options"] = r.options;
  if (r.scale !== null) m["scale"] = r.scale;
  if (r.attachments !== null) m["attachments"] = r.attachments;
  return m as Manifest;
}

// ---- create -----------------------------------------------------------------

export interface NewAwaitingRequest {
  id: string;
  /** The validated manifest; its question is the agent's draft. */
  manifest: Manifest;
  participant_id: string;
  /** The delivery time validation computed; recomputed on Send. */
  deliver_at: Date;
  /** `approvalTokenHash(token)`: the token itself is never stored. */
  approval_token_hash: string;
  approval_expires_at: Date;
  now: Date;
}

/**
 * Record a validated request as `awaiting_approval` with its first event
 * (null → awaiting_approval, by the principal), in one transaction. Nothing
 * is held or delivered. A taken id throws `RequestIdTaken` (draw another).
 */
export async function createAwaitingRequest(db: A2hDb, r: NewAwaitingRequest): Promise<void> {
  const m = r.manifest;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(requests).values({
        id: r.id,
        principal_id: m.principal_id,
        participant_id: r.participant_id,
        intent: m.intent,
        audience: m.audience,
        time_shape: m.time_shape,
        format: m.format,
        lane: m.lane,
        free_lane: m.free_lane ?? null,
        question: m.question,
        agent_draft: m.question,
        options: m.options ?? null,
        scale: m.scale ?? null,
        attachments: m.attachments ?? null,
        data_terms: m.data_terms,
        bid_minor: m.bid_minor,
        currency: m.currency,
        status: "awaiting_approval",
        deliver_at: r.deliver_at,
        expires_at: new Date(m.expires_at),
        approval_token_hash: r.approval_token_hash,
        approval_expires_at: r.approval_expires_at,
        created_at: r.now,
        updated_at: r.now,
      });
      await tx.insert(requestEvents).values({ request_id: r.id, from_status: null, to_status: "awaiting_approval", actor: "principal", at: r.now });
    });
  } catch (error) {
    if (isUniqueViolation(error, "requests_pkey")) throw new RequestIdTaken();
    throw error;
  }
}

// ---- decide -----------------------------------------------------------------

export interface ApprovalDecision {
  request_id: string;
  /** The `t` of the link, as presented. */
  token: string;
  /** The signed-in principal of the page's session (apps/web checked the session and the allow-list). */
  principal_id: string;
  now: Date;
  /** The stage's fee rate (configuration, ADR 0002). */
  fee_rate: number;
  /**
   * Send: the question as the page posted it, line breaks as the browser sent
   * them; `approvedQuestion` settles it against the locked row's draft, so
   * the caller reads nothing of the request on its own (review F2).
   */
  decision: { kind: "send"; question: string } | { kind: "dont_send" };
}

/** A textarea holds LF line breaks only (HTML's value normalisation): the field and its draft compare as the browser saw them. */
function asTextarea(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * The question as approved (spec "Accept after editing": byte-identical to
 * the edited text). Browsers post a textarea's line breaks as CR LF; the
 * field held LF, so LF is what was approved. Unchanged up to line breaks, it
 * is the agent's draft byte for byte.
 */
export function approvedQuestion(posted: string, agentDraft: string): string {
  const text = asTextarea(posted);
  return text === asTextarea(agentDraft) ? agentDraft : text;
}

/**
 * What the page shows. `link_invalid` (unknown request or a token the server
 * did not issue) and `expired` look the same to the viewer (spec "Forged
 * token"); `wrong_principal` says the link belongs to another account and
 * nothing else. `invalid`: Send was refused by validation, nothing changed,
 * the request stays awaiting approval; `error.detail` is category text only.
 * `sent` carries the question as approved, for the page to show; a refused
 * question is not echoed.
 */
export type ApprovalOutcome =
  | { kind: "sent"; question: string; deliver_at: string; eta: string; deferred: boolean; held_minor: number; currency: string }
  | { kind: "not_sent"; reason: "declined" }
  | { kind: "invalid"; error: ProtocolError }
  | { kind: "already_decided"; status: RequestStatus; decided_at: string }
  | { kind: "expired" }
  | { kind: "link_invalid" }
  | { kind: "wrong_principal" };

async function moveTo(tx: A2hDb, row: RequestRow, actor: "principal" | "platform", event: "approve" | "decline" | "expire", now: Date, set: Partial<RequestRow>): Promise<boolean> {
  const t = transition(row.status as RequestStatus, actor, event);
  if (!t.ok || !t.changed) return false;
  await tx.update(requests).set({ ...set, status: t.to, updated_at: now }).where(eq(requests.id, row.id));
  await tx.insert(requestEvents).values({ request_id: row.id, from_status: t.from, to_status: t.to, actor, at: now });
  return true;
}

async function expireLocked(tx: A2hDb, row: RequestRow, now: Date): Promise<boolean> {
  if (row.status !== "awaiting_approval" || !row.approval_expires_at || row.approval_expires_at.getTime() > now.getTime()) return false;
  return moveTo(tx, row, "platform", "expire", now, { not_sent_reason: "expired" satisfies NotSentReason });
}

async function lock(tx: A2hDb, requestId: string): Promise<RequestRow | undefined> {
  const [row] = await tx.select().from(requests).where(eq(requests.id, requestId)).for("update");
  return row;
}

/**
 * Send or Don't send, in one transaction (D4): lock the request; check the
 * token's hash, the principal, the status and the link's expiry; for Send,
 * load the participant's current rules, the principal's policy and today's
 * counts and run `validateManifest` on the manifest with the approved
 * question; on success store the question and the new delivery time and
 * move to `sent` with its event, otherwise change nothing (a rules-stage
 * refusal is counted for the participant). Don't send moves to `not_sent`
 * (`declined`) without validation. A late decision on an expired link moves
 * the request to `not_sent` (`expired`), so a stale link never sends.
 */
export async function decideApproval(db: A2hDb, d: ApprovalDecision): Promise<ApprovalOutcome> {
  if (!ApprovalTokenSchema.safeParse(d.token).success) return { kind: "link_invalid" };
  const presented = await approvalTokenHash(d.token);
  return db.transaction(async (tx): Promise<ApprovalOutcome> => {
    const row = await lock(tx, d.request_id);
    if (!row || row.approval_token_hash === null || row.approval_token_hash !== presented) return { kind: "link_invalid" };
    if (row.principal_id !== d.principal_id) return { kind: "wrong_principal" };
    if (row.status === "not_sent" && row.not_sent_reason === "expired") return { kind: "expired" };
    if (row.status !== "awaiting_approval") {
      const [decided] = await tx
        .select({ at: requestEvents.at })
        .from(requestEvents)
        .where(and(eq(requestEvents.request_id, row.id), eq(requestEvents.from_status, "awaiting_approval")));
      return { kind: "already_decided", status: row.status as RequestStatus, decided_at: (decided?.at ?? row.updated_at).toISOString() };
    }
    if (await expireLocked(tx, row, d.now)) return { kind: "expired" };

    if (d.decision.kind === "dont_send") {
      await moveTo(tx, row, "principal", "decline", d.now, { not_sent_reason: "declined" });
      return { kind: "not_sent", reason: "declined" };
    }

    // Settled under the lock, after the token and principal checks: the draft is read for nobody else.
    const question = approvedQuestion(d.decision.question, row.agent_draft ?? row.question);
    const owner = await principalWithPolicy(tx, row.principal_id);
    if (!owner) {
      return { kind: "invalid", error: { code: "principal_not_accountable", stage: "principal", retryable: false, detail: "The principal of this request is not set up any more." } };
    }
    const policy = { ...owner.policy, fee_rate: d.fee_rate };
    // The participant as delivery sees it: the handle and the rules published now (none: accepts nothing).
    const [who] = await tx.select({ handle: participants.handle }).from(participants).where(eq(participants.id, row.participant_id));
    const participant = { participant_id: row.participant_id, handle: who!.handle, rules: await currentRules(tx, row.participant_id) };
    const facts = await approvalFacts(tx, { principal: owner.principal, currency: policy.currency, participant, now: d.now, approval: "recorded" });
    const manifest = { ...manifestOfRequest(row, participant.handle), question };
    const v = validateManifest(manifest, facts, policy);
    if (!v.ok) {
      if (v.blocked) await recordBlockedManifest(tx, { ...v.blocked, request_id: row.id });
      return { kind: "invalid", error: v.error };
    }
    await moveTo(tx, row, "principal", "approve", d.now, { question, deliver_at: new Date(v.deliver_at) });
    return { kind: "sent", question, deliver_at: v.deliver_at, eta: v.eta, deferred: v.deferred, held_minor: row.bid_minor, currency: row.currency };
  });
}

// ---- expire -----------------------------------------------------------------

/** Move one awaiting request past its link's expiry to `not_sent` (`expired`), by the platform. True if it changed. */
export async function expireApproval(db: A2hDb, requestId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await lock(tx, requestId);
    return row ? expireLocked(tx, row, now) : false;
  });
}

/** Ids of awaiting requests whose link has expired at `now`, oldest first. */
export async function dueApprovals(db: A2hDb, now: Date, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: requests.id })
    .from(requests)
    .where(and(eq(requests.status, "awaiting_approval"), lte(requests.approval_expires_at, now)))
    .orderBy(asc(requests.approval_expires_at))
    .limit(limit);
  return rows.map((r) => r.id);
}
