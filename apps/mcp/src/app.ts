// The HTTP shell: health, the MCP endpoint, 404 for everything else, request
// logging and graceful shutdown. Plain node:http, no framework.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import type { McpDb } from "@a2h/db";
import type { Principal, ValidationPolicy } from "@a2h/protocol";
import { createMcpHandler, createRequestStateCodec, type McpServerFactory } from "@modelcontextprotocol/server";
import { healthPathFor } from "./health-path.ts";
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./http-timeouts.ts";
import type { LogLine } from "./logging.ts";
import { createMcpServer } from "./mcp-server.ts";
import type { ApprovalState, ToolDeps } from "./tools/common.ts";

export type { LogLine } from "./logging.ts";

/** Approval state lives 15 minutes (design D1); an older state is refused. */
export const APPROVAL_TTL_SECONDS = 15 * 60;

/** What the A2H tools need; production builds it from infra/env.ts and src/db.ts. */
export interface A2hOptions {
  db: McpDb;
  principal: Principal;
  policy: ValidationPolicy;
  clearingShare: number;
  /** HMAC key of the approval state (32 bytes or more), the same on every instance of the stage. */
  approvalKey: Uint8Array;
  /** The clock; tests pin it. */
  now?: () => Date;
  /** Randomness for request ids; tests pin it. */
  randomBytes?: (n: number) => Uint8Array;
}

export interface AppOptions {
  stage: string;
  /** `/mcp` or `/pr-<n>/mcp` (env MCP_BASE_PATH). */
  mcpBasePath: string;
  log: (line: LogLine) => void;
  /** Override the per-request server factory (tests count its calls). */
  factory?: McpServerFactory;
  /** The A2H tools' dependencies. Without them the server offers `ping` only (M0 tests). */
  a2h?: A2hOptions;
}

export interface App {
  server: Server;
  /**
   * Stop accepting, let in-flight requests finish for up to `graceMs`, then
   * end whatever is left. Resolves when the listener is closed.
   */
  shutdown: (graceMs: number) => Promise<void>;
}

// Accept a caller's request id only if it is short and plain; otherwise make
// one, so a header cannot smuggle arbitrary data into the logs.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdOf(req: IncomingMessage): string {
  const header = req.headers["x-request-id"];
  return typeof header === "string" && SAFE_REQUEST_ID.test(header) ? header : randomUUID();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function toolDeps(stage: string, o: A2hOptions, log: (line: LogLine) => void): ToolDeps {
  const principalId = o.principal.principal_id;
  return {
    stage,
    db: o.db,
    principal: o.principal,
    policy: o.policy,
    clearingShare: o.clearingShare,
    // HMAC-signed (not encrypted) state, bound to the principal of the
    // connection: a state minted for one principal fails for another.
    codec: createRequestStateCodec<ApprovalState>({ key: o.approvalKey, ttlSeconds: APPROVAL_TTL_SECONDS, bind: () => principalId }),
    now: o.now ?? (() => new Date()),
    randomBytes: o.randomBytes ?? ((n) => new Uint8Array(randomBytes(n))),
    log,
  };
}

export function createApp(options: AppOptions): App {
  const { stage, mcpBasePath, log } = options;
  const healthPath = healthPathFor(mcpBasePath);
  const stopping = new AbortController();
  const a2h = options.a2h ? toolDeps(stage, options.a2h, log) : undefined;
  const factory: McpServerFactory =
    options.factory ?? (() => createMcpServer(stage, { signal: stopping.signal, ...(a2h ? { a2h } : {}) }));

  // Stateless by default: a fresh server per request, no session ids.
  // keepAliveMs 0: no SSE comment frames, so a held ping sends nothing at all
  // until its result and "Idle stream survives" really tests the
  // infrastructure's idle timeouts.
  const handler = createMcpHandler(factory, {
    keepAliveMs: 0,
    onerror: (error) => log({ level: "error", msg: "mcp handler error", error: error.name }),
  });
  const mcp = toNodeHandler(handler, {
    onerror: (error) => log({ level: "error", msg: "mcp adapter error", error: error.name }),
  });

  const server = createServer((req, res) => {
    const started = performance.now();
    const requestId = requestIdOf(req);
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    res.setHeader("x-request-id", requestId);
    // The tools read it back for their log lines (correlation with this one).
    req.headers["x-request-id"] = requestId;
    res.once("close", () => {
      log({
        level: "info",
        msg: "request",
        method,
        path,
        status: res.statusCode,
        duration_ms: Math.round(performance.now() - started),
        http_request_id: requestId,
      });
    });

    if (path === healthPath) {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
      } else if (stopping.signal.aborted) {
        sendJson(res, 503, { ok: false });
      } else {
        sendJson(res, 200, { ok: true });
      }
      return;
    }
    if (path === mcpBasePath) {
      // The adapter's duck type declares `method: string`; Node types it
      // `string | undefined` (never undefined for a server request). Under
      // exactOptionalPropertyTypes that needs this cast.
      void mcp(req as NodeIncomingMessageLike, res);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.timeout = 0;

  async function shutdown(graceMs: number): Promise<void> {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    let timer: NodeJS.Timeout | undefined;
    const graceOver = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    });
    await Promise.race([closed, graceOver]);
    clearTimeout(timer);
    // Whatever is still running (a held ping) is ended now.
    stopping.abort();
    await handler.close();
    server.closeAllConnections();
    await closed;
  }

  return { server, shutdown };
}
