// The A2H MCP server definition: one fresh instance per HTTP request
// (createMcpHandler's stateless default). Nothing here may keep state across
// requests (spec mcp-transport, "Endpoint is stateless across instances"):
// the approval state travels with the client (design D1), requests live in
// Postgres.
import { setTimeout as sleep } from "node:timers/promises";
import {
  CheckRequestsOutputSchema,
  FindHumansOutputSchema,
  PING_MAX_HOLD_SECONDS,
  PingInputSchema,
  RequestHumanOutputSchema,
  pingJsonSchemas,
  toolJsonSchemas,
} from "@a2h/protocol";
import { McpServer, type CallToolResult, type InputRequiredResult, type ServerContext } from "@modelcontextprotocol/server";
import { toolLogLine, type ToolLogFields } from "./logging.ts";
import { checkRequests } from "./tools/check-requests.ts";
import type { A2hSession, HeldPings } from "./session.ts";
import { errorResult, httpRequestId, listedInput, listedOutput, listedValidated, type ToolDeps } from "./tools/common.ts";
import { findHumans } from "./tools/find-humans.ts";
import { CHECK_REQUESTS_DESCRIPTION, FIND_HUMANS_DESCRIPTION, REQUEST_HUMAN_DESCRIPTION } from "./tools/policy.ts";
import { requestHuman, type RequestHumanOutcome } from "./tools/request-human.ts";
import { PACKAGE_VERSION } from "./version.ts";

export { PING_MAX_HOLD_SECONDS };

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
  /** The A2H tools of this request (its caller, the codec). Without it only `ping` is served. */
  a2h?: A2hSession;
  /** The instance's cap on held pings (PING_MAX_CONCURRENT). Without it holds are not capped (tests). */
  heldPings?: HeldPings;
}

/** A held ping refused because the instance already holds its cap (spec hosted-endpoint "Cap reached"). */
export const PING_CAP_ERROR = {
  code: "rate_limited",
  stage: "throttle",
  retryable: true,
  detail: "Too many held pings on this instance right now; retry later.",
} as const;

export function createMcpServer(stage: string, options: McpServerOptions = {}): McpServer {
  const session = options.a2h;
  const server = new McpServer(
    { name: "a2h", version: PACKAGE_VERSION },
    // Approval state we did not mint, that was altered or that expired is
    // refused here, before any handler runs: JSON-RPC -32602
    // `invalid_request_state` (design D1, spec "Forged or expired approval state").
    session ? { requestState: { verify: (state, ctx) => session.codec.verify(state, ctx) } } : {},
  );
  server.registerTool(
    "ping",
    {
      description: PING_DESCRIPTION,
      // From the protocol export like every tool (review N6), validated by the SDK.
      inputSchema: listedValidated(PingInputSchema, pingJsonSchemas().input),
    },
    async ({ holdSeconds = 0 }, ctx) => {
      if (holdSeconds > 0) {
        // Refused at once over the cap, never queued; held calls are unaffected.
        const held = options.heldPings;
        if (held && !held.tryAcquire()) return errorResult({ ...PING_CAP_ERROR });
        try {
          const signals = [ctx.mcpReq.signal];
          if (options.signal) signals.push(options.signal);
          await sleep(holdSeconds * 1000, undefined, { signal: AbortSignal.any(signals) });
        } finally {
          held?.release();
        }
      }
      return { content: [{ type: "text", text: `pong from stage ${stage}` }] };
    },
  );
  if (session) registerA2hTools(server, session);
  return server;
}

type Fields = Omit<ToolLogFields, "tool" | "http_request_id" | "principal_id" | "client_id" | "duration_ms">;

function logged(session: A2hSession, tool: string, ctx: ServerContext, started: number, fields: Fields): void {
  session.log(
    toolLogLine({
      tool,
      http_request_id: httpRequestId(ctx),
      principal_id: session.caller?.principal_id,
      client_id: session.caller?.client_id,
      duration_ms: Math.round(performance.now() - started),
      ...fields,
    }),
  );
}

/**
 * Run an A2H tool: the principal is loaded and the call counted first
 * (before any validation); a refusal there writes nothing else.
 */
async function run<R extends { result: CallToolResult | InputRequiredResult; log: Fields }>(
  session: A2hSession,
  tool: string,
  ctx: ServerContext,
  body: (deps: ToolDeps) => Promise<R>,
): Promise<CallToolResult | InputRequiredResult> {
  const started = performance.now();
  const opened = await session.open();
  if (!opened.ok) {
    logged(session, tool, ctx, started, { outcome: "error", code: opened.error.code, error_stage: opened.error.stage });
    return errorResult(opened.error);
  }
  const { result, log } = await body(opened.deps);
  logged(session, tool, ctx, started, log);
  return result;
}

function registerA2hTools(server: McpServer, session: A2hSession): void {
  const json = toolJsonSchemas();

  server.registerTool(
    "find_humans",
    {
      description: FIND_HUMANS_DESCRIPTION,
      inputSchema: listedInput(json.find_humans.input),
      outputSchema: listedOutput(FindHumansOutputSchema, json.find_humans.output),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx) =>
      (await run(session, "find_humans", ctx, async (deps) => {
        const { result, results, code } = await findHumans(deps, args);
        return { result, log: { outcome: result.isError ? "error" : "ok", results, code } };
      })) as CallToolResult,
  );

  server.registerTool(
    "request_human",
    {
      description: REQUEST_HUMAN_DESCRIPTION,
      inputSchema: listedInput(json.request_human.input),
      outputSchema: listedOutput(RequestHumanOutputSchema, json.request_human.output),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => run(session, "request_human", ctx, (deps): Promise<RequestHumanOutcome> => requestHuman(deps, args, ctx)),
  );

  server.registerTool(
    "check_requests",
    {
      description: CHECK_REQUESTS_DESCRIPTION,
      inputSchema: listedInput(json.check_requests.input),
      outputSchema: listedOutput(CheckRequestsOutputSchema, json.check_requests.output),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx) => (await run(session, "check_requests", ctx, (deps) => checkRequests(deps, args))) as CallToolResult,
  );
}
