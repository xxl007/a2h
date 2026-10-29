// Queries of the mcp service (m1-protocol-connector tasks 4.2 to 4.4): what
// find_humans, request_human and check_requests read and write. Every value
// that crosses this boundary is a protocol shape or a plain row; the caller
// (apps/mcp) owns validation, display and logging.
import {
  type BlockedManifest,
  type FreeLaneKind,
  type Manifest,
  type RatingSummary,
  type RequestStatus,
  type RulesOfEngagement,
  type SigningKeyStatus,
  type Topic,
  TopicSchema,
  type TypeRule,
  type WhoMayAsk,
} from "@a2h/protocol";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { answers, blockedManifests, participants, profiles, requestEvents, requests, rules, ruleTypes, signingKeys } from "../schema.ts";

/** The database handle the mcp service uses (Drizzle over node-postgres). */
export type McpDb = NodePgDatabase<Record<string, unknown>>;

/** A participant as published: what discovery and validation need. No name, no contact. */
export interface PublishedParticipant {
  participant_id: string;
  handle: string;
  simulated: boolean;
  identity_verified: boolean;
  topics: Topic[];
  rating: RatingSummary;
  rules: RulesOfEngagement;
}

const TopicsSchema = TopicSchema.array().min(1);

async function loadPublished(db: McpDb, where?: ReturnType<typeof eq>): Promise<PublishedParticipant[]> {
  const rows = await db
    .select({
      participant_id: participants.id,
      handle: participants.handle,
      simulated: participants.simulated,
      identity_verified: participants.identity_verified,
      topics: profiles.topics,
      rating: profiles.rating,
      answers_count: profiles.answers_count,
      disputes_lost: profiles.disputes_lost,
      typical_latency_seconds: profiles.typical_latency_seconds,
      who_may_ask: rules.who_may_ask,
      free_lanes: rules.free_lanes,
      quiet_start: rules.quiet_start,
      quiet_end: rules.quiet_end,
      quiet_time_zone: rules.quiet_time_zone,
      max_interruptions_per_day: rules.max_interruptions_per_day,
      latency_promise_seconds: rules.latency_promise_seconds,
    })
    .from(participants)
    .innerJoin(profiles, eq(profiles.participant_id, participants.id))
    .innerJoin(rules, eq(rules.participant_id, participants.id))
    .where(where)
    .orderBy(participants.handle);
  if (rows.length === 0) return [];
  const types = await db
    .select()
    .from(ruleTypes)
    .where(inArray(ruleTypes.participant_id, rows.map((r) => r.participant_id)))
    .orderBy(ruleTypes.participant_id, ruleTypes.intent);
  return rows.map((r) => ({
    participant_id: r.participant_id,
    handle: r.handle,
    simulated: r.simulated,
    identity_verified: r.identity_verified,
    // Written by the seed (and later the onboarding form) from protocol values; checked again here.
    topics: TopicsSchema.parse(r.topics),
    rating: {
      rating: r.rating,
      answers: r.answers_count,
      disputes_lost: r.disputes_lost,
      typical_latency_seconds: r.typical_latency_seconds,
    },
    rules: {
      types: types
        .filter((t) => t.participant_id === r.participant_id)
        .map((t): TypeRule => ({ intent: t.intent as TypeRule["intent"], accepted: t.accepted, reserve_net_minor: t.reserve_net_minor, currency: t.currency })),
      free_lanes: r.free_lanes as FreeLaneKind[],
      who_may_ask: r.who_may_ask as WhoMayAsk,
      quiet_hours:
        r.quiet_start !== null && r.quiet_end !== null && r.quiet_time_zone !== null
          ? { start: r.quiet_start, end: r.quiet_end, time_zone: r.quiet_time_zone }
          : null,
      max_interruptions_per_day: r.max_interruptions_per_day,
      latency_promise_seconds: r.latency_promise_seconds,
    },
  }));
}

/** Every participant with a published profile and rules, ordered by handle. Reads only. */
export function listPublishedParticipants(db: McpDb): Promise<PublishedParticipant[]> {
  return loadPublished(db);
}

/** One published participant by handle, or null. Reads only. */
export async function findPublishedParticipant(db: McpDb, handle: string): Promise<PublishedParticipant | null> {
  return (await loadPublished(db, eq(participants.handle, handle)))[0] ?? null;
}

/** Deliveries to a participant scheduled in [from, to), whatever their status (deferred ones included). */
export async function countDeliveries(db: McpDb, participantId: string, from: Date, to: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(requests)
    .where(and(eq(requests.participant_id, participantId), gte(requests.deliver_at, from), lt(requests.deliver_at, to)));
  return row?.n ?? 0;
}

/**
 * What a principal has committed: the gross amount still held or cleared by
 * requests created since `monthStart` (released holds count for nothing), and
 * how many requests it created since `dayStart`.
 */
export async function principalUsage(
  db: McpDb,
  principalId: string,
  monthStart: Date,
  dayStart: Date,
): Promise<{ committed_minor: number; requests_today: number }> {
  const [row] = await db
    .select({
      committed: sql<number>`coalesce(sum(CASE
        WHEN ${requests.status} IN ('sent', 'accepted') THEN ${requests.bid_minor}
        WHEN ${requests.status} = 'answered' THEN coalesce(${requests.cleared_minor}, ${requests.bid_minor})
        ELSE 0 END), 0)::int`,
      today: sql<number>`count(*) FILTER (WHERE ${requests.created_at} >= ${dayStart.toISOString()})::int`,
    })
    .from(requests)
    .where(and(eq(requests.principal_id, principalId), gte(requests.created_at, monthStart)));
  return { committed_minor: row?.committed ?? 0, requests_today: row?.today ?? 0 };
}

/** Count a manifest blocked by a participant's rules: ids, stage, code and time only. */
export async function recordBlockedManifest(db: McpDb, b: BlockedManifest): Promise<void> {
  await db.insert(blockedManifests).values({
    request_id: b.request_id ?? null,
    participant_id: b.participant_id,
    principal_id: b.principal_id,
    stage: b.stage,
    code: b.code,
    at: new Date(b.at),
  });
}

/** Thrown by `createRequest` when the id is taken; the caller draws another. */
export class RequestIdTaken extends Error {
  constructor() {
    super("request id already exists");
    this.name = "RequestIdTaken";
  }
}

/** Thrown by `createRequest` when the approval nonce already created a request (a replayed approval). */
export class ApprovalAlreadyUsed extends Error {
  constructor() {
    super("approval already used");
    this.name = "ApprovalAlreadyUsed";
  }
}

/** True when an approval with this nonce already created a request. */
export async function approvalNonceUsed(db: McpDb, nonce: string): Promise<boolean> {
  const rows = await db.select({ id: requests.id }).from(requests).where(eq(requests.approval_nonce, nonce)).limit(1);
  return rows.length > 0;
}

export interface NewRequest {
  id: string;
  /** The nonce of the accepted approval: unique, so one approval creates one request. */
  approval_nonce: string;
  manifest: Manifest;
  participant_id: string;
  deliver_at: Date;
  now: Date;
}

/**
 * Create a request in `sent` with its first event (null → sent, by the
 * principal), in one transaction: both rows or neither. The approval nonce
 * is written in the same row: a second request for the same accepted
 * approval fails on its unique index (`ApprovalAlreadyUsed`).
 */
export async function createRequest(db: McpDb, r: NewRequest): Promise<void> {
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
        approval_nonce: r.approval_nonce,
        options: m.options ?? null,
        scale: m.scale ?? null,
        attachments: m.attachments ?? null,
        data_terms: m.data_terms,
        bid_minor: m.bid_minor,
        currency: m.currency,
        status: "sent",
        deliver_at: r.deliver_at,
        expires_at: new Date(m.expires_at),
        created_at: r.now,
        updated_at: r.now,
      });
      await tx.insert(requestEvents).values({ request_id: r.id, from_status: null, to_status: "sent", actor: "principal", at: r.now });
    });
  } catch (error) {
    if (isUniqueViolation(error, "requests_pkey")) throw new RequestIdTaken();
    if (isUniqueViolation(error, "requests_approval_nonce_unique")) throw new ApprovalAlreadyUsed();
    throw error;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const pgError = e as Error & { code?: string; constraint?: string };
    if (pgError.code === "23505" && pgError.constraint === constraint) return true;
  }
  return false;
}

/** One request of a principal as check_requests reads it. Holds no question text. */
export interface RequestRecord {
  id: string;
  status: RequestStatus;
  intent: string;
  lane: string;
  bid_minor: number;
  cleared_minor: number | null;
  currency: string;
  created_at: Date;
  participant: { participant_id: string; handle: string; display_label: string; simulated: boolean; identity_verified: boolean };
  /** Gross reserve basis: the participant's current net reserve for the intent, if any. */
  reserve_net_minor: number | null;
  events: Array<{ to_status: RequestStatus; at: Date }>;
  answer: {
    participant_id: string;
    body: unknown;
    confidence: number;
    answered_personally: boolean;
    signed_at: string;
    key_id: string;
    signature: string;
    key: { public_key: string; status: SigningKeyStatus } | null;
  } | null;
}

export type RequestQuery = { request_id: string } | { status?: RequestStatus; since?: Date; limit: number };

/**
 * The principal's requests: one by id, or a filtered page, newest first. A
 * request of another principal is never returned.
 */
export async function findRequests(db: McpDb, principalId: string, q: RequestQuery): Promise<RequestRecord[]> {
  const conditions = [eq(requests.principal_id, principalId)];
  let limit = 1;
  if ("request_id" in q) {
    conditions.push(eq(requests.id, q.request_id));
  } else {
    if (q.status !== undefined) conditions.push(eq(requests.status, q.status));
    if (q.since !== undefined) conditions.push(gte(requests.created_at, q.since));
    limit = q.limit;
  }
  const rows = await db
    .select({
      id: requests.id,
      status: requests.status,
      intent: requests.intent,
      lane: requests.lane,
      bid_minor: requests.bid_minor,
      cleared_minor: requests.cleared_minor,
      currency: requests.currency,
      created_at: requests.created_at,
      participant_id: participants.id,
      handle: participants.handle,
      display_label: participants.display_label,
      simulated: participants.simulated,
      identity_verified: participants.identity_verified,
      reserve_net_minor: ruleTypes.reserve_net_minor,
    })
    .from(requests)
    .innerJoin(participants, eq(participants.id, requests.participant_id))
    .leftJoin(ruleTypes, and(eq(ruleTypes.participant_id, requests.participant_id), eq(ruleTypes.intent, requests.intent)))
    .where(and(...conditions))
    .orderBy(desc(requests.created_at), desc(requests.id))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const events = await db
    .select({ request_id: requestEvents.request_id, to_status: requestEvents.to_status, at: requestEvents.at })
    .from(requestEvents)
    .where(inArray(requestEvents.request_id, ids))
    .orderBy(requestEvents.id);
  const answerRows = await db
    .select({
      request_id: answers.request_id,
      participant_id: answers.participant_id,
      body: answers.body,
      confidence: answers.confidence,
      answered_personally: answers.answered_personally,
      signed_at: answers.signed_at,
      key_id: answers.key_id,
      signature: answers.signature,
      public_key: signingKeys.public_key,
      key_status: signingKeys.status,
    })
    .from(answers)
    .leftJoin(signingKeys, eq(signingKeys.key_id, answers.key_id))
    .where(inArray(answers.request_id, ids));
  return rows.map((r) => {
    const a = answerRows.find((x) => x.request_id === r.id);
    return {
      id: r.id,
      status: r.status as RequestStatus,
      intent: r.intent,
      lane: r.lane,
      bid_minor: r.bid_minor,
      cleared_minor: r.cleared_minor,
      currency: r.currency,
      created_at: r.created_at,
      participant: {
        participant_id: r.participant_id,
        handle: r.handle,
        display_label: r.display_label,
        simulated: r.simulated,
        identity_verified: r.identity_verified,
      },
      reserve_net_minor: r.reserve_net_minor,
      events: events.filter((e) => e.request_id === r.id).map((e) => ({ to_status: e.to_status as RequestStatus, at: e.at })),
      answer: a
        ? {
            participant_id: a.participant_id,
            body: a.body,
            confidence: a.confidence,
            answered_personally: a.answered_personally,
            signed_at: a.signed_at,
            key_id: a.key_id,
            signature: a.signature,
            key: a.public_key !== null && a.key_status !== null ? { public_key: a.public_key, status: a.key_status as SigningKeyStatus } : null,
          }
        : null,
    };
  });
}
