// What every A2H tool shares: its dependencies, the JSON Schema of its
// input and output (from the protocol export, spec protocol/schemas "Tool
// schemas come from the export"), errors as ProtocolError, money display.
import type { McpDb } from "@a2h/db";
import type { Principal, ProtocolError, ValidationPolicy } from "@a2h/protocol";
import type { CallToolResult, RequestStateCodec, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type * as z from "zod";
import type { Log } from "../logging.ts";

/** What the approval state carries (design D1): no question, only the manifest's hash. */
export interface ApprovalState {
  principal_id: string;
  manifest_hash: string;
  nonce: string;
  issued_at: string;
}

export interface ToolDeps {
  stage: string;
  db: McpDb;
  principal: Principal;
  policy: ValidationPolicy;
  clearingShare: number;
  codec: RequestStateCodec<ApprovalState>;
  now: () => Date;
  randomBytes: (n: number) => Uint8Array;
  log: Log;
}

type JsonSchema = Record<string, unknown>;

/**
 * A tool input schema the SDK lists exactly as the protocol export (`json`)
 * and does not validate: the handler parses the arguments with the protocol
 * schema itself, so a bad argument becomes a `schema_invalid` ProtocolError
 * naming the field, like every other A2H refusal.
 */
export function listedInput(json: JsonSchema): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "a2h",
      validate: (value) => ({ value: value as Record<string, unknown> }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

/** A schema listed as the protocol export (`json`) and validated with the protocol schema: tool outputs, and ping's input. */
export function listedOutput<T>(schema: z.ZodType<T>, json: JsonSchema): StandardSchemaWithJSON<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "a2h",
      validate: (value) => {
        const r = schema.safeParse(value);
        return r.success ? { value: r.data } : { issues: r.error.issues.map((i) => ({ message: i.message, path: i.path })) };
      },
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

/** A refusal as a tool result: `isError`, the code and category text, and the ProtocolError as structured content. */
/** Alias of `listedOutput` for an input the SDK should validate (ping). */
export const listedValidated = listedOutput;

export function errorResult(error: ProtocolError, extra?: string): CallToolResult {
  const text = `${error.code}: ${error.detail ?? "refused"}${error.retryable ? " (retryable)" : ""}${extra ? `\n${extra}` : ""}`;
  return { isError: true, content: [{ type: "text", text }], structuredContent: { error } };
}

/** Parse tool arguments with a protocol schema; on failure a `schema_invalid` error naming the first offending field. */
export function parseArgs<T>(schema: z.ZodType<T>, args: unknown): { ok: true; data: T } | { ok: false; error: ProtocolError } {
  const r = schema.safeParse(args ?? {});
  if (r.success) return { ok: true, data: r.data };
  const path = r.error.issues[0]?.path.join(".") || "(root)";
  return { ok: false, error: { code: "schema_invalid", stage: "schema", retryable: false, detail: `Invalid field: ${path}.` } };
}

const SYMBOL: Record<string, string> = { EUR: "€", GBP: "£", USD: "$" };

/** `€31.25` from 3125 EUR; amounts are integers in minor units (two decimals for the v1 currencies). */
export function money(minor: number, currency: string): string {
  const whole = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  const symbol = SYMBOL[currency];
  return symbol ? `${symbol}${whole}.${cents}` : `${whole}.${cents} ${currency}`;
}

/** Request id of the HTTP request (set by app.ts), for log correlation. */
export function httpRequestId(ctx: { http?: { req?: { headers: { get(name: string): string | null } } } }): string | undefined {
  return ctx.http?.req?.headers.get("x-request-id") ?? undefined;
}
