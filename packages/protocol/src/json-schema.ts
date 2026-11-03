// JSON Schema export (design D5): what MCP tools register as inputSchema /
// outputSchema, and what REST and webhooks will publish.
import * as z from "zod";
import {
  CheckRequestsInputSchema,
  CheckRequestsOutputSchema,
  FindHumansInputSchema,
  FindHumansOutputSchema,
  PingInputSchema,
  RequestHumanInputSchema,
  RequestHumanOutputSchema,
} from "./tools.ts";

export type JsonSchema = Record<string, unknown>;

/**
 * Draft 2020-12 JSON Schema of a protocol schema. `io: "input"` describes
 * what a caller may send, `"output"` what the server returns. Refinements
 * (cross-field rules) are not expressible and are enforced by the Zod schema.
 */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output" = "output"): JsonSchema {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "throw" });
}

/** The Zod schemas of each A2H tool, for registration in apps/mcp. */
export const TOOL_SCHEMAS = {
  find_humans: { input: FindHumansInputSchema, output: FindHumansOutputSchema },
  request_human: { input: RequestHumanInputSchema, output: RequestHumanOutputSchema },
  check_requests: { input: CheckRequestsInputSchema, output: CheckRequestsOutputSchema },
} as const;
export type ToolName = keyof typeof TOOL_SCHEMAS;

/** JSON Schema of every tool's input and output. */
export function toolJsonSchemas(): Record<ToolName, { input: JsonSchema; output: JsonSchema }> {
  const out = {} as Record<ToolName, { input: JsonSchema; output: JsonSchema }>;
  for (const name of Object.keys(TOOL_SCHEMAS) as ToolName[]) {
    out[name] = { input: toJsonSchema(TOOL_SCHEMAS[name].input, "input"), output: toJsonSchema(TOOL_SCHEMAS[name].output, "output") };
  }
  return out;
}

/** JSON Schema of `ping`'s input (it has no output schema): every listed tool's schema comes from this package. */
export function pingJsonSchemas(): { input: JsonSchema } {
  return { input: toJsonSchema(PingInputSchema, "input") };
}
