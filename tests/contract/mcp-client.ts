// Fresh MCP clients for the contract tests, each with its own recording fetch
// so a test can assert what went over the wire (JSON-RPC methods sent, any
// Mcp-Session-Id header in either direction), not only what the SDK returned.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { DiscoverResult, FetchLike } from "@modelcontextprotocol/client";
import { Agent, fetch as undiciFetch } from "undici";
import { bearerToken, mcpUrl } from "../src/live-env.ts";

/** The MCP revision the A2H server implements (contract, PM 2026-10-25). */
export const PROTOCOL_VERSION = "2026-07-28";

export interface Exchange {
  httpMethod: string;
  /** JSON-RPC methods in the request body (a batch gives several). */
  rpcMethods: string[];
  status: number;
  requestSessionId: string | null;
  responseSessionId: string | null;
}

function rpcMethodsOf(body: unknown): string[] {
  if (typeof body !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(body);
    const messages = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
    return messages.flatMap((m) =>
      m && typeof m === "object" && "method" in m && typeof m.method === "string" ? [m.method] : [],
    );
  } catch {
    return [];
  }
}

function sessionHeaderOf(headers: RequestInit["headers"] | undefined): string | null {
  return new Headers(headers).get("mcp-session-id");
}

/**
 * Node's global fetch (undici 6) cuts a response after 300 s without headers
 * or without body bytes. The idle-stream test waits 61 minutes on purpose, so
 * it uses undici's fetch with both timeouts off: if the stream dies, the
 * infrastructure cut it, not this client.
 */
const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const patientFetch: FetchLike = (url, init) =>
  // undici's Response type and the DOM one differ in stream generics only.
  undiciFetch(url, { ...(init as object), dispatcher: noTimeoutAgent }) as unknown as Promise<Response>;

/**
 * A fetch that records its exchanges and, unless `token` is null, sends
 * `Authorization: Bearer <token>` (A2H_TOKEN by default: the signed-in
 * principal of the verify job; m1-hosted-connector task 8.3). Tokenless
 * clients (`token: null`) are for the challenge scenarios.
 */
export function recordingFetch(base: FetchLike = globalThis.fetch, token: string | null | undefined = bearerToken()): {
  fetch: FetchLike;
  exchanges: Exchange[];
} {
  const exchanges: Exchange[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await base(url, { ...init, headers });
    exchanges.push({
      httpMethod: init?.method ?? "GET",
      rpcMethods: rpcMethodsOf(init?.body),
      status: response.status,
      requestSessionId: sessionHeaderOf(init?.headers),
      responseSessionId: response.headers.get("mcp-session-id"),
    });
    return response;
  };
  return { fetch, exchanges };
}

export interface FreshClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  exchanges: Exchange[];
  close: () => Promise<void>;
}

export interface ConnectOptions {
  /** Adopt another client's discover result: the first request this client sends is the caller's. */
  prior?: DiscoverResult;
  /** No client-side timeouts (idle-stream test). */
  patient?: boolean;
  /** Connect timeout in ms. */
  timeout?: number;
  /** Bearer token; default A2H_TOKEN; null: send none. */
  token?: string | null;
}

/** A new Client and transport, pinned to the 2026-07-28 revision, connected. */
export async function connectFresh(options: ConnectOptions = {}): Promise<FreshClient> {
  const { fetch, exchanges } = recordingFetch(options.patient ? patientFetch : globalThis.fetch, options.token);
  const client = new Client(
    { name: "a2h-contract-tests", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  const transport = new StreamableHTTPClientTransport(mcpUrl(), { fetch });
  const connectOptions = {
    ...(options.prior ? { prior: { kind: "modern" as const, discover: options.prior } } : {}),
    timeout: options.timeout ?? 10_000,
  };
  try {
    await client.connect(transport, connectOptions);
  } catch (error) {
    // The SDK's pinned-mode error does not say what the server answered; the wire does.
    const wire = exchanges.map((e) => `${e.httpMethod} ${e.rpcMethods.join(",") || "-"} -> HTTP ${e.status}`);
    throw new Error(`connect to ${mcpUrl().href} failed [${wire.join("; ") || "no HTTP response"}]`, {
      cause: error,
    });
  }
  return {
    client,
    transport,
    exchanges,
    close: async () => {
      await client.close();
    },
  };
}
