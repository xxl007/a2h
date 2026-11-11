// Helpers for the A2H contract and adversarial suites against a live stage
// (A2H_MCP_URL): request_human and its URL elicitation driven by hand with the
// official v2 client, check_requests listings, bounded polling, and the
// budget guard that skips a flow before the server would refuse it.
// Shapes come from @a2h/protocol; participants and personas from the seed.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { CheckRequestsOutputSchema, RequestHumanOutputSchema, type CheckedRequest, type RequestHumanOutput } from "@a2h/protocol";
import { SEED_PARTICIPANTS, SEED_PERSONAS, type SeedParticipant } from "../../packages/db/seed/simulated.ts";
import { developmentPolicy, stageInfo } from "../../infra/config.ts";
import { expectedStage, mcpUrl } from "../src/live-env.ts";
import { PROTOCOL_VERSION, recordingFetch, type Exchange } from "./mcp-client.ts";
import { guardVerdict, SENT_STATUSES, usageOf, type Usage } from "../lib/budget.ts";

export type Args = Record<string, unknown>;

// ---- time -------------------------------------------------------------------

/**
 * The server's clock as the tests assume it. Live stages run on real time;
 * the local stage (tests/local/stage.ts) can pin the MCP clock, and then
 * A2H_SERVER_NOW must carry the same instant.
 */
const SERVER_NOW = process.env["A2H_SERVER_NOW"]?.trim();
const serverOffsetMs = SERVER_NOW ? Date.parse(SERVER_NOW) - Date.now() : 0;
if (Number.isNaN(serverOffsetMs)) throw new Error(`A2H_SERVER_NOW is not a date: ${SERVER_NOW}`);

export function serverNow(): Date {
  return new Date(Date.now() + serverOffsetMs);
}

/** ISO 8601 with an explicit +00:00 offset and whole seconds (the protocol's datetime form). */
export function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/**
 * The instant every expiry is computed from: the server's now when this
 * module loaded, so that building the same manifest twice (first leg and
 * retry) gives the same `expires_at`, hence the same manifest hash. A run
 * lasts minutes; expiries carry margins of half an hour or more.
 */
const EXPIRY_ANCHOR_MS = serverNow().getTime();

/** An expiry `seconds` after the anchor (the server's now at load time). */
export function expiresIn(seconds: number): string {
  return iso(new Date(EXPIRY_ANCHOR_MS + seconds * 1000));
}

// ---- seed -------------------------------------------------------------------

export function seeded(handle: string): SeedParticipant {
  const p = SEED_PARTICIPANTS.find((s) => s.handle === handle);
  assert.ok(p, `${handle} is not in the simulated seed`);
  return p;
}

/** Seconds before the persona of `handle` acts (seed). */
export function personaDelay(handle: string): number {
  const persona = SEED_PERSONAS.find((p) => p.persona === seeded(handle).persona);
  assert.ok(persona);
  return persona.delay_seconds;
}

/** The participant's latency promise plus a margin: the shortest expiry its rules accept. */
export function shortestExpiry(handle: string, marginSeconds = 30 * 60): string {
  return expiresIn(seeded(handle).rules.latency_promise_seconds + marginSeconds);
}

/** Gross reserve for `intent` at the stage's fee rate (fee_percent from find_humans). */
export function grossReserve(handle: string, intent: string, feePercent: number): number {
  const rule = seeded(handle).rules.types.find((t) => t.intent === intent);
  assert.ok(rule, `${handle} publishes no ${intent} rule`);
  // Half up, once (protocol/schemas "Gross from net rounds once").
  return Math.round(rule.reserve_net_minor / (1 - feePercent / 100));
}

export const DATA_TERMS = { storage: "principal_workspace", attribution: "attributed", training: "off" } as const;

/** A paid one-shot manifest; callers override what their scenario needs. */
export function manifest(handle: string, intent: string, bid_minor: number, question: string, extra: Args = {}): Args {
  return {
    to: handle,
    intent,
    audience: "named_individual",
    time_shape: "one_shot",
    format: "single_field",
    question,
    lane: "paid",
    bid_minor,
    currency: "EUR",
    expires_at: shortestExpiry(handle),
    data_terms: { ...DATA_TERMS },
    ...extra,
  };
}

// ---- clients ----------------------------------------------------------------

export interface A2hClient {
  client: Client;
  exchanges: Exchange[];
  close: () => Promise<void>;
}

/**
 * A 2026-07-28 client that never fulfils input requests by itself: the test
 * plays the host, round by round. By default it declares no elicitation at
 * all (spec "Client without URL elicitation": the link comes in the result
 * text); `url: true` declares URL elicitation (spec "Client with URL
 * elicitation"), as a host that can show an "open this page" prompt does.
 */
export async function principalClient(options: { url?: boolean; token?: string | null } = {}): Promise<A2hClient> {
  const { fetch, exchanges } = recordingFetch(globalThis.fetch, options.token);
  const client = new Client(
    { name: options.url ? "a2h-contract-principal-url" : "a2h-contract-principal", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: PROTOCOL_VERSION } },
      capabilities: options.url ? { elicitation: { url: {} } } : {},
      inputRequired: { autoFulfill: false },
    },
  );
  await client.connect(new StreamableHTTPClientTransport(mcpUrl(), { fetch }), { timeout: 30_000 });
  return { client, exchanges, close: () => client.close() };
}

/** A 2025-era client (what Claude Code negotiated by default in M1), which says it can show forms. */
export async function legacyClient(onElicit: () => void, token: string | null | undefined = undefined): Promise<A2hClient> {
  const { fetch, exchanges } = recordingFetch(globalThis.fetch, token);
  const client = new Client({ name: "a2h-contract-legacy", version: "0.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler("elicitation/create", () => {
    onElicit();
    return Promise.resolve({ action: "decline" as const });
  });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl(), { fetch }), { timeout: 30_000 });
  return { client, exchanges, close: () => client.close() };
}

/** The URL elicitation of the 2026-07-28 revision (design D3). */
export interface UrlElicitParams {
  mode?: string;
  message: string;
  url?: string;
}

export interface InputRequiredRound {
  resultType: "input_required";
  inputRequests?: Record<string, { method: string; params: UrlElicitParams }>;
  requestState?: string;
}

export type Raw = InputRequiredRound | CallToolResult;

export function isInputRequired(r: Raw): r is InputRequiredRound {
  return (r as InputRequiredRound).resultType === "input_required";
}

/** First leg: the raw result, `input_required` (the URL elicitation) or a final result. */
export async function firstLeg(c: A2hClient, args: Args): Promise<Raw> {
  return (await c.client.callTool({ name: "request_human", arguments: args }, { allowInputRequired: true, timeout: 30_000 }));
}

export interface Awaiting {
  result: CallToolResult;
  out: RequestHumanOutput & { status: "awaiting_approval"; approval_url: string; approval_expires_at: string };
  /** How long the call took, client side. */
  ms: number;
}

/**
 * `request_human` for a manifest that passes validation, on a client without
 * URL elicitation: the request is recorded awaiting approval and the result
 * carries the link (spec "Link returned"). Fails the test otherwise.
 */
export async function requestAwaiting(c: A2hClient, args: Args): Promise<Awaiting> {
  const t0 = performance.now();
  const raw = await firstLeg(c, args);
  const ms = performance.now() - t0;
  assert.ok(!isInputRequired(raw), "a client without URL elicitation was asked through an elicitation");
  assert.ok(!raw.isError, `request_human to ${String(args["to"])} was refused: ${describe(raw)}`);
  const out = RequestHumanOutputSchema.parse(raw.structuredContent);
  assert.equal(out.status, "awaiting_approval", describe(raw));
  return { result: raw, out: out as Awaiting["out"], ms };
}

/** The answer of the host to the URL elicitation: opened (accept), refused (decline) or dismissed (cancel). */
export type Answer = { action: "accept" } | { action: "decline" } | { action: "cancel" };

/** The 2026-07-28 retry: same tool and arguments, plus inputResponses and the echoed state. */
export async function retryLeg(c: A2hClient, args: Args, state: string | undefined, answer: Answer): Promise<CallToolResult> {
  const params = {
    name: "request_human",
    arguments: args,
    inputResponses: { approval: answer },
    ...(state !== undefined ? { requestState: state } : {}),
  };
  return (await c.client.callTool(params, { allowInputRequired: true, timeout: 30_000 }));
}

export function texts(result: CallToolResult): string {
  return result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
}

/** A short description of a result for assertion messages: never the question (it is not in results). */
export function describe(raw: Raw): string {
  if (isInputRequired(raw)) return "input_required";
  return `${raw.isError ? "isError " : ""}${JSON.stringify(raw.structuredContent ?? texts(raw)).slice(0, 400)}`;
}

export interface ToolError {
  code: string;
  stage: string;
  retryable: boolean;
  detail?: string;
  request_id?: string;
}

/** The ProtocolError of an error result. */
export function errorOf(raw: Raw): ToolError {
  assert.ok(!isInputRequired(raw), "expected a refusal, but the approval was shown");
  assert.equal(raw.isError, true, `expected an error result, got ${describe(raw)}`);
  const error = (raw.structuredContent as { error?: ToolError } | undefined)?.error;
  assert.ok(error, `error result without structuredContent.error: ${describe(raw)}`);
  return error;
}

// ---- check_requests -----------------------------------------------------------

export async function checkOne(c: A2hClient, id: string): Promise<CheckedRequest> {
  const result = (await c.client.callTool({ name: "check_requests", arguments: { request_id: id } }, { timeout: 30_000 }));
  assert.ok(!result.isError, `check_requests ${id}: ${describe(result)}`);
  const out = CheckRequestsOutputSchema.parse(result.structuredContent);
  assert.equal(out.requests.length, 1);
  return out.requests[0]!;
}

/** Requests sent at or after `since` (newest first, at most 100), optionally in one status. */
export async function listSince(c: A2hClient, since: Date, status?: string): Promise<CheckedRequest[]> {
  const args: Args = { since: iso(new Date(since.getTime() - 1000)), limit: 100, ...(status ? { status } : {}) };
  const result = (await c.client.callTool({ name: "check_requests", arguments: args }, { timeout: 30_000 }));
  assert.ok(!result.isError, `check_requests ${JSON.stringify(args)}: ${describe(result)}`);
  return CheckRequestsOutputSchema.parse(result.structuredContent).requests;
}

/** "Nothing was created": no request to `handle` sent since `since`. */
export async function assertNothingCreatedFor(c: A2hClient, handle: string, since: Date): Promise<void> {
  const created = (await listSince(c, since)).filter((r) => r.handle === handle);
  assert.deepEqual(created.map((r) => r.request_id), [], `requests to ${handle} were created since ${iso(since)}`);
}

/** Polls `probe` every `everyMs` until it returns a value, or fails after `boundMs`. */
export async function until<T>(what: string, boundMs: number, probe: () => Promise<T | undefined>, everyMs = 2_000): Promise<T> {
  const end = Date.now() + boundMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(boundMs / 1000)} s waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Waits until the request leaves `from` statuses; returns the request as first seen outside them. */
export async function untilStatusNot(c: A2hClient, id: string, from: string[], boundMs: number, everyMs = 2_000): Promise<CheckedRequest> {
  return until(`${id} to leave ${from.join("/")}`, boundMs, async () => {
    const r = await checkOne(c, id);
    return from.includes(r.status) ? undefined : r;
  }, everyMs);
}

// ---- budget guard ---------------------------------------------------------------

/**
 * What the principal behind `c` has committed this UTC month and how many
 * requests it sent today, counted exactly as the server counts them before it
 * refuses with over_budget or rate_limited (lib/budget.ts, issue #114): one
 * listing per status that counts, each since the month start, so requests
 * awaiting approval or not sent (which hold nothing) never crowd the ones that
 * do out of a listing.
 */
export async function usage(c: A2hClient): Promise<Usage> {
  const now = serverNow();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const byStatus: Record<string, CheckedRequest[]> = {};
  for (const status of SENT_STATUSES) byStatus[status] = await listSince(c, monthStart, status);
  return usageOf(byStatus, monthStart, dayStart);
}

/**
 * The QA principal's policy on the stage under test, from the same source the
 * deployment uses (infra/config.ts developmentPolicy, design D7): dev has ten
 * times the monthly budget, prod and previews the base. Each principal has its
 * own policy row, created from this at its first consent: a fresh per-run
 * principal (previews) starts with all of it.
 */
export function stagePolicy(): { monthly_budget_minor: number; daily_request_limit: number } {
  return developmentPolicy(stageInfo(expectedStage()));
}

/**
 * A skip reason when committing up to `cost_minor` more over `requests` more
 * sent requests would take the principal past what the server accepts; false
 * otherwise. A snapshot: flows that spend at the same time (the background
 * expiry flows, the other file of a step) are not in it, so a run must fit the
 * budget on its own (tests/README.md "Budget"). The usage is printed, amounts
 * only, so a run's log shows what each guarded flow found.
 */
export async function budgetGuard(c: A2hClient, cost_minor: number, requests: number): Promise<string | false> {
  const u = await usage(c);
  const verdict = guardVerdict(u, stagePolicy(), cost_minor, requests);
  console.log(`budget guard: committed ${u.committed_minor}, sent today ${u.requests_today}${u.complete ? "" : " (lower bounds)"}; flow up to ${cost_minor} over ${requests} requests → ${verdict ? "skip" : "run"}`);
  return verdict;
}
