// The A2H MCP server definition: one fresh instance per HTTP request
// (createMcpHandler's stateless default). Nothing here may keep state across
// requests (spec mcp-transport, "Endpoint is stateless across instances"):
// the approval state travels with the client (design D1), requests live in
// Postgres.
import { setTimeout as sleep } from "node:timers/promises";
import { toolJsonSchemas, CheckRequestsOutputSchema, FindHumansOutputSchema, RequestHumanOutputSchema } from "@a2h/protocol";
import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod";
import { toolLogLine, type ToolLogFields } from "./logging.ts";
import { checkRequests } from "./tools/check-requests.ts";
import { httpRequestId, listedInput, listedOutput, type ToolDeps } from "./tools/common.ts";
import { findHumans } from "./tools/find-humans.ts";
import { CHECK_REQUESTS_DESCRIPTION, FIND_HUMANS_DESCRIPTION, REQUEST_HUMAN_DESCRIPTION } from "./tools/policy.ts";
import { requestHuman, type RequestHumanOutcome } from "./tools/request-human.ts";
import { PACKAGE_VERSION } from "./version.ts";

/** Upper bound of ping's hold: 65 minutes, enough for the 61-minute scenario. */
export const PING_MAX_HOLD_SECONDS = 3900;

export const PING_DESCRIPTION =
  "Connectivity check. Answers `pong from stage <stage>` with the name of the " +
  "deployment stage that served the call. Optional `holdSeconds` (integer, " +
  `0 to ${PING_MAX_HOLD_SECONDS}, default 0) makes the server wait that long ` +
  "before answering, sending nothing in the meantime; it exists so that QA " +
  "can prove an idle stream survives the infrastructure for over an hour " +
  "(mcp-transport scenario \"Idle stream survives\"). It has no other effect.";

export interface McpServerOptions {
  /** Aborted when the process shuts down, so held pings end promptly. */
  signal?: AbortSignal;
  /** The A2H tools' dependencies. Without them only `ping` is served. */
  a2h?: ToolDeps;
}

export function createMcpServer(stage: string, options: McpServerOptions = {}): McpServer {
  const deps = options.a2h;
  const server = new McpServer(
    { name: "a2h", version: PACKAGE_VERSION },
    // Approval state we did not mint, that was altered or that expired is
    // refused here, before any handler runs: JSON-RPC -32602
    // `invalid_request_state` (design D1, spec "Forged or expired approval state").
    deps ? { requestState: { verify: (state, ctx) => deps.codec.verify(state, ctx) } } : {},
  );
  server.registerTool(
    "ping",
    {
      description: PING_DESCRIPTION,
      inputSchema: z.object({
        holdSeconds: z.number().int().min(0).max(PING_MAX_HOLD_SECONDS).optional(),
      }),
    },
    async ({ holdSeconds = 0 }, ctx) => {
      if (holdSeconds > 0) {
        const signals = [ctx.mcpReq.signal];
        if (options.signal) signals.push(options.signal);
        await sleep(holdSeconds * 1000, undefined, { signal: AbortSignal.any(signals) });
      }
      return { content: [{ type: "text", text: `pong from stage ${stage}` }] };
    },
  );
  if (deps) registerA2hTools(server, deps);
  return server;
}

function logged(deps: ToolDeps, tool: string, ctx: ServerContext, started: number, fields: Omit<ToolLogFields, "tool" | "http_request_id" | "principal_id" | "duration_ms">): void {
  deps.log(
    toolLogLine({
      tool,
      http_request_id: httpRequestId(ctx),
      principal_id: deps.principal.principal_id,
      duration_ms: Math.round(performance.now() - started),
      ...fields,
    }),
  );
}

function registerA2hTools(server: McpServer, deps: ToolDeps): void {
  const json = toolJsonSchemas();

  server.registerTool(
    "find_humans",
    {
      description: FIND_HUMANS_DESCRIPTION,
      inputSchema: listedInput(json.find_humans.input),
      outputSchema: listedOutput(FindHumansOutputSchema, json.find_humans.output),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx): Promise<CallToolResult> => {
      const started = performance.now();
      const { result, results, code } = await findHumans(deps, args);
      logged(deps, "find_humans", ctx, started, { outcome: result.isError ? "error" : "ok", results, code });
      return result;
    },
  );

  server.registerTool(
    "request_human",
    {
      description: REQUEST_HUMAN_DESCRIPTION,
      inputSchema: listedInput(json.request_human.input),
      outputSchema: listedOutput(RequestHumanOutputSchema, json.request_human.output),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      const started = performance.now();
      const outcome: RequestHumanOutcome = await requestHuman(deps, args, ctx);
      logged(deps, "request_human", ctx, started, outcome.log);
      return outcome.result;
    },
  );

  server.registerTool(
    "check_requests",
    {
      description: CHECK_REQUESTS_DESCRIPTION,
      inputSchema: listedInput(json.check_requests.input),
      outputSchema: listedOutput(CheckRequestsOutputSchema, json.check_requests.output),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx): Promise<CallToolResult> => {
      const started = performance.now();
      const { result, log } = await checkRequests(deps, args);
      logged(deps, "check_requests", ctx, started, log);
      return result;
    },
  );
}
