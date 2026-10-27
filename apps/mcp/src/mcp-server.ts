// The A2H MCP server definition: one fresh instance per HTTP request
// (createMcpHandler's stateless default). Nothing here may keep state across
// requests (spec mcp-transport, "Endpoint is stateless across instances").
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
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
}

export function createMcpServer(stage: string, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "a2h", version: PACKAGE_VERSION });
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
  return server;
}
