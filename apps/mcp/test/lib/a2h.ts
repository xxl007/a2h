// In-process A2H server for tool tests: the real HTTP app and the real tools
// over a real Postgres schema, with a fixed clock and the official client.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, FetchLike } from "@modelcontextprotocol/client";
import type { Principal, ValidationPolicy } from "@a2h/protocol";
import type { DbConfig } from "../../src/config.ts";
import { openDatabase } from "../../src/db.ts";
import { start, type Running } from "../helpers.ts";

export const TEST_PRINCIPAL: Principal = { principal_id: "dev-principal-test", identity_mode: "verified_organisation", verified: true };
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
/** Tuesday 27 Oct 2026, 10:00 in Paris: outside every seeded quiet window. */
export const NOW = new Date("2026-10-27T09:00:00Z");

export interface A2hOptions {
  principal?: Principal;
  policy?: ValidationPolicy;
  approvalKey?: Uint8Array;
  now?: () => Date;
  randomBytes?: (n: number) => Uint8Array;
  stage?: string;
}

export interface RunningA2h extends Running {
  url: string;
}

export async function startA2h(db: DbConfig, options: A2hOptions = {}): Promise<RunningA2h> {
  const database = openDatabase(db);
  const running = await start({
    stage: options.stage ?? "test",
    a2h: {
      db: database.db,
      principal: options.principal ?? TEST_PRINCIPAL,
      policy: options.policy ?? TEST_POLICY,
      clearingShare: 0.5,
      approvalKey: options.approvalKey ?? TEST_APPROVAL_KEY,
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
