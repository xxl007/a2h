// The HTTP shell: health, the protected-resource metadata, the MCP
// endpoint behind the bearer gate (m1-hosted-connector design D3), 404 for
// everything else, request logging and graceful shutdown. Plain node:http,
// no framework.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler, type McpServerFactory, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { type AuthConfig, type Caller, callerOf, createGate } from "./auth.ts";
import { healthPathFor } from "./health-path.ts";
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./http-timeouts.ts";
import type { LogLine } from "./logging.ts";
import { createMcpServer } from "./mcp-server.ts";
import { a2hSession, type A2hOptions, HeldPings } from "./session.ts";

export type { LogLine } from "./logging.ts";
export { APPROVAL_TTL_SECONDS, type A2hOptions, type RateLimits } from "./session.ts";
export type { AuthConfig } from "./auth.ts";

export interface AppOptions {
  stage: string;
  /** `/mcp` or `/pr-<n>/mcp` (env MCP_BASE_PATH). */
  mcpBasePath: string;
  log: (line: LogLine) => void;
  /** The resource-server settings (AUTH_REQUIRED, AUTH_ISSUER, AUTH_JWKS_URL, MCP_RESOURCE_URL, PING_OPEN). */
  auth: AuthConfig;
  /** Held pings this instance carries at once (PING_MAX_CONCURRENT). */
  pingMaxConcurrent: number;
  /** With the gate off: who every call acts for. Default `dev-principal-<stage>` (tests override it). */
  fallbackPrincipalId?: string;
  /** Override the token verifier (tests); default: the JWKS verifier of auth.ts. */
  verifier?: OAuthTokenVerifier;
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

export function createApp(options: AppOptions): App {
  const { stage, mcpBasePath, log, auth } = options;
  const healthPath = healthPathFor(mcpBasePath);
  const stopping = new AbortController();
  const heldPings = new HeldPings(options.pingMaxConcurrent);
  const gate = createGate(auth, ...(options.verifier ? [options.verifier] : []));
  // AUTH_REQUIRED=false (dev and previews only, the env adapter refuses it on
  // prod): every call acts for the stage's fallback principal.
  const fallback: Caller | undefined = auth.required ? undefined : { principal_id: options.fallbackPrincipalId ?? `dev-principal-${stage}` };
  const a2h = options.a2h;
  const factory: McpServerFactory =
    options.factory ??
    ((ctx) =>
      createMcpServer(stage, {
        signal: stopping.signal,
        heldPings,
        ...(a2h ? { a2h: a2hSession(stage, a2h, fallback ?? callerOf(ctx.authInfo), log) } : {}),
      }));

  // Stateless by default: a fresh server per request, no session ids.
  // keepAliveMs 0: no SSE comment frames, so a held ping sends nothing at all
  // until its result and "Idle stream survives" really tests the
  // infrastructure's idle timeouts.
  const handler = createMcpHandler(factory, {
    keepAliveMs: 0,
    onerror: (error) => log({ level: "error", msg: "mcp handler error", error: error.name }),
  });
  // Who each in-flight HTTP request acts for, by request id, for its access log line.
  const callers = new Map<string, Caller>();
  const gated = toNodeHandler(
    {
      fetch: async (request) => {
        const metadata = await gate.metadata(request);
        if (metadata) return metadata;
        const outcome = await gate.check(request);
        if (!outcome.ok) return outcome.response;
        const caller = fallback ?? callerOf(outcome.authInfo);
        const id = request.headers.get("x-request-id");
        if (caller && id) callers.set(id, caller);
        return handler.fetch(request, {
          ...(outcome.authInfo ? { authInfo: outcome.authInfo } : {}),
          ...(outcome.parsedBody !== undefined ? { parsedBody: outcome.parsedBody } : {}),
        });
      },
    },
    { onerror: (error) => log({ level: "error", msg: "mcp adapter error", error: error.name }) },
  );

  const server = createServer((req, res) => {
    const started = performance.now();
    const requestId = requestIdOf(req);
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    res.setHeader("x-request-id", requestId);
    // The tools read it back for their log lines (correlation with this one).
    req.headers["x-request-id"] = requestId;
    res.once("close", () => {
      const caller = callers.get(requestId);
      callers.delete(requestId);
      log({
        level: "info",
        msg: "request",
        method,
        path,
        status: res.statusCode,
        duration_ms: Math.round(performance.now() - started),
        http_request_id: requestId,
        // Opaque ids only (design D10): never a token, never an email.
        ...(caller ? { principal_id: caller.principal_id } : {}),
        ...(caller?.client_id ? { client_id: caller.client_id } : {}),
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
    if (path === mcpBasePath || path === gate.metadataPath) {
      // The adapter's duck type declares `method: string`; Node types it
      // `string | undefined` (never undefined for a server request). Under
      // exactOptionalPropertyTypes that needs this cast.
      void gated(req as NodeIncomingMessageLike, res);
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
