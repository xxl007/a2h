// In-process A2H server for tool tests: the real HTTP app and the real tools
// over a real Postgres schema, with a fixed clock and the official client.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, FetchLike } from "@modelcontextprotocol/client";
import type { Principal, ValidationPolicy } from "@a2h/protocol";
import { decideApproval, ensurePrincipal, type ApprovalOutcome } from "@a2h/db";
import type { DbConfig } from "../../src/config.ts";
import { openDatabase } from "../../src/db.ts";
import type { AuthConfig } from "../../src/auth.ts";
import type { RateLimits } from "../../src/session.ts";
import { start, type Running } from "../helpers.ts";
import { sqlIn } from "./db.ts";

/** The default signed-in principal, as consent creates it (`consentPrincipal`): real name, verified by the owner's allow-list. Not the seeded fallback `dev-principal-test`, so consent, not the seed, writes its rows. */
export const TEST_PRINCIPAL: Principal = { principal_id: "user-test-principal", identity_mode: "real_name", verified: true };
export const TEST_POLICY: ValidationPolicy = {
  fee_rate: 0.2,
  currency: "EUR",
  monthly_budget_minor: 50_000,
  per_request_cap_minor: 6_000,
  ask_first_above_minor: null,
  daily_request_limit: 50,
  throttled_daily_limit: 5,
};
export const TEST_APPROVAL_KEY = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
/** The stage's web host in tests: where approval links point (from AUTH_ISSUER's origin in production). */
export const TEST_WEB_ORIGIN = "https://web.a2h.test";
/** Tuesday 27 Oct 2026, 10:00 in Paris: outside every seeded quiet window. */
export const NOW = new Date("2026-10-27T09:00:00Z");

export interface A2hOptions {
  principal?: Principal;
  policy?: ValidationPolicy;
  approvalKey?: Uint8Array;
  now?: () => Date;
  randomBytes?: (n: number) => Uint8Array;
  stage?: string;
  /** The gate (default off: every call acts for `principal`). */
  auth?: AuthConfig;
  limits?: RateLimits;
  pingMaxConcurrent?: number;
  /**
   * false: do not create the principal's rows (a token whose account never
   * consented). Otherwise the default principal is created by consent
   * (`consentPrincipal`); an explicit `principal` is written as given
   * (`ensurePrincipalRows`), for states consent never produces.
   */
  ensurePrincipal?: boolean;
}

/**
 * Create a principal and its policy exactly as the web app's consent step
 * does: `@a2h/db` ensurePrincipal with the stage's default policy and no
 * identity mode of its own. Idempotent, like consent. Returns the principal
 * as stored. (Test setup; the mcp service never writes these rows.)
 */
export async function consentPrincipal(db: DbConfig, principalId: string, policy: ValidationPolicy = TEST_POLICY): Promise<Principal> {
  // The principal's own policy: the fee rate is the stage's, not stored with the principal.
  const own = {
    currency: policy.currency,
    monthly_budget_minor: policy.monthly_budget_minor,
    per_request_cap_minor: policy.per_request_cap_minor,
    ask_first_above_minor: policy.ask_first_above_minor,
    daily_request_limit: policy.daily_request_limit,
    throttled_daily_limit: policy.throttled_daily_limit,
  };
  const database = openDatabase(db);
  try {
    return (await ensurePrincipal(database.db, principalId, { policy: own })).principal;
  } finally {
    await database.close();
  }
}

/**
 * Write a principal's rows as given (upsert), for states consent never
 * produces (unverified, another identity mode, no verification method).
 * The signed-in principal of a test is created with `consentPrincipal`.
 */
export async function ensurePrincipalRows(db: DbConfig, principal: Principal, policy: ValidationPolicy): Promise<void> {
  await sqlIn(
    db,
    `INSERT INTO principals (principal_id, identity_mode, verified) VALUES ($1, $2, $3)
     ON CONFLICT (principal_id) DO UPDATE SET identity_mode = EXCLUDED.identity_mode, verified = EXCLUDED.verified`,
    [principal.principal_id, principal.identity_mode, principal.verified],
  );
  await sqlIn(
    db,
    `INSERT INTO principal_policies (principal_id, currency, monthly_budget_minor, per_request_cap_minor, ask_first_above_minor, daily_request_limit, throttled_daily_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (principal_id) DO UPDATE SET currency = EXCLUDED.currency, monthly_budget_minor = EXCLUDED.monthly_budget_minor,
       per_request_cap_minor = EXCLUDED.per_request_cap_minor, ask_first_above_minor = EXCLUDED.ask_first_above_minor,
       daily_request_limit = EXCLUDED.daily_request_limit, throttled_daily_limit = EXCLUDED.throttled_daily_limit`,
    [principal.principal_id, policy.currency, policy.monthly_budget_minor, policy.per_request_cap_minor, policy.ask_first_above_minor, policy.daily_request_limit, policy.throttled_daily_limit],
  );
}

export interface RunningA2h extends Running {
  url: string;
}

export async function startA2h(db: DbConfig, options: A2hOptions = {}): Promise<RunningA2h> {
  const principal = options.principal ?? TEST_PRINCIPAL;
  const policy = options.policy ?? TEST_POLICY;
  if (options.ensurePrincipal !== false) {
    if (options.principal) await ensurePrincipalRows(db, principal, policy);
    else await consentPrincipal(db, principal.principal_id, policy);
  }
  const database = openDatabase(db);
  const running = await start({
    stage: options.stage ?? "test",
    fallbackPrincipalId: principal.principal_id,
    pingMaxConcurrent: options.pingMaxConcurrent ?? 4,
    ...(options.auth ? { auth: options.auth } : {}),
    a2h: {
      db: database.db,
      feeRate: policy.fee_rate,
      limits: options.limits ?? { perMinute: 60, perDay: 2000 },
      clearingShare: 0.5,
      approvalKey: options.approvalKey ?? TEST_APPROVAL_KEY,
      webOrigin: TEST_WEB_ORIGIN,
      now: options.now ?? (() => NOW),
      ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
    },
  });
  return {
    ...running,
    url: `${running.origin}/mcp`,
    stop: async () => {
      await running.stop();
      await database.close();
    },
  };
}

export type ElicitAnswer = { action: "accept"; content: Record<string, string | number | boolean | string[]> } | { action: "decline" | "cancel" };

/**
 * A 2026-07-28 client that declares form elicitation. With `answer` it
 * fulfils input requests itself (as a host does); without, the test drives
 * the rounds by hand (`allowInputRequired`).
 */
export async function modernClient(url: string, answer?: (params: ElicitParams) => ElicitAnswer, fetch?: FetchLike): Promise<Client> {
  const client = new Client(
    { name: "a2h-test", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: { elicitation: { form: {} } },
      inputRequired: { autoFulfill: answer !== undefined },
    },
  );
  if (answer) client.setRequestHandler("elicitation/create", (req) => Promise.resolve(answer(req.params as unknown as ElicitParams)));
  await client.connect(new StreamableHTTPClientTransport(new URL(url), fetch ? { fetch } : {}));
  return client;
}

/** A 2026-07-28 client that declares URL elicitation (and forms); the test plays the host, round by round. */
export async function urlClient(url: string, fetch?: FetchLike): Promise<Client> {
  const client = new Client(
    { name: "a2h-test-url", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { elicitation: { form: {}, url: {} } }, inputRequired: { autoFulfill: false } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url), fetch ? { fetch } : {}));
  return client;
}

/**
 * What the approval page does on Send or Don't send (apps/web, design D4):
 * the shared `decideApproval` with the link's request id and token, as the
 * signed-in principal. Send keeps the stored question unless `question` is given.
 */
export async function approveOnPage(
  db: DbConfig,
  approvalUrl: string,
  o: { decision?: "send" | "dont_send"; question?: string; principal_id?: string; now?: Date; fee_rate?: number } = {},
): Promise<ApprovalOutcome> {
  const link = new URL(approvalUrl);
  const id = link.pathname.split("/").at(-1)!;
  const token = link.searchParams.get("t") ?? "";
  const [row] = await sqlIn<{ question: string }>(db, "SELECT question FROM requests WHERE id = $1", [id]);
  const database = openDatabase(db);
  try {
    return await decideApproval(database.db, {
      request_id: id,
      token,
      principal_id: o.principal_id ?? TEST_PRINCIPAL.principal_id,
      now: o.now ?? NOW,
      fee_rate: o.fee_rate ?? TEST_POLICY.fee_rate,
      decision: (o.decision ?? "send") === "send" ? { kind: "send", question: o.question ?? row?.question ?? "" } : { kind: "dont_send" },
    });
  } finally {
    await database.close();
  }
}

/** A 2025-era client (what Claude Code negotiates by default). */
export async function legacyClient(url: string, onElicit?: () => void): Promise<Client> {
  const client = new Client({ name: "a2h-legacy", version: "0.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler("elicitation/create", () => {
    onElicit?.();
    return Promise.resolve({ action: "decline" as const });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

export interface ElicitParams {
  mode?: string;
  message: string;
  requestedSchema: { type: string; properties: Record<string, Record<string, unknown>>; required?: string[] };
}

export interface InputRequiredRound {
  resultType: "input_required";
  inputRequests?: Record<string, { method: string; params: ElicitParams }>;
  requestState?: string;
}

/** First leg of a manual round trip; returns the raw result (input_required or a final result). */
export async function callRaw(client: Client, name: string, args: Record<string, unknown>): Promise<InputRequiredRound | CallToolResult> {
  return await client.callTool({ name, arguments: args }, { allowInputRequired: true });
}

export function isInputRequired(r: InputRequiredRound | CallToolResult): r is InputRequiredRound {
  return (r as InputRequiredRound).resultType === "input_required";
}

/** The 2026-07-28 retry: same name and arguments, plus inputResponses and the echoed state. */
export async function retry(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  state: string | undefined,
  responses: Record<string, unknown>,
): Promise<CallToolResult> {
  // The SDK's callTool params type does not declare the 2026-07-28 retry
  // members; they pass through on the wire (as in the m1 spike).
  const params = { name, arguments: args, inputResponses: responses, ...(state !== undefined ? { requestState: state } : {}) };
  return client.callTool(params, { allowInputRequired: true });
}

export function texts(result: CallToolResult): string[] {
  return result.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
}
