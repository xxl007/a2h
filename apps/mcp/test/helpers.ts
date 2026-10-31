// Test helpers: run the real HTTP app in-process on an ephemeral port and
// connect the official MCP client to it.
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { drizzle } from "drizzle-orm/node-postgres";
import { createApp, type A2hOptions, type App, type AppOptions, type AuthConfig, type LogLine } from "../src/app.ts";

export interface Running {
  app: App;
  origin: string;
  logs: LogLine[];
  stop: () => Promise<void>;
}

/**
 * The A2H tools over a database stub: enough to list them and to call ping.
 * A tool call that reaches the database fails; tool tests use lib/a2h.ts.
 */
export function offlineA2h(): A2hOptions {
  return {
    db: drizzle.mock(),
    feeRate: 0.2,
    clearingShare: 0.5,
    approvalKey: new Uint8Array(32).fill(1),
    limits: { perMinute: 60, perDay: 2000 },
  };
}

/** The gate off (AUTH_REQUIRED=false), as the M1 tests ran; authorization tests pass their own. */
export const NO_AUTH: AuthConfig = {
  required: false,
  issuer: "http://127.0.0.1:1/api/auth",
  jwksUrl: "http://127.0.0.1:1/api/auth/jwks",
  resourceUrl: "https://mcp.dev.a2h.test/mcp",
  pingOpen: false,
};

/** The real HTTP app with the A2H tools (offline unless `a2h` is given). */
export async function start(options: Partial<AppOptions> = {}): Promise<Running> {
  const logs: LogLine[] = [];
  const app = createApp({
    stage: "test",
    mcpBasePath: "/mcp",
    log: (line) => logs.push(line),
    auth: NO_AUTH,
    pingMaxConcurrent: 4,
    a2h: offlineA2h(),
    ...options,
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    origin: `http://127.0.0.1:${port}`,
    logs,
    stop: () => app.shutdown(1000),
  };
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type Era = "legacy" | "modern";

export async function connect(
  url: string,
  options: { era?: Era; fetch?: FetchLike } = {},
): Promise<Client> {
  const client = new Client(
    { name: "a2h-test", version: "0.0.0" },
    options.era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    options.fetch ? { fetch: options.fetch } : {},
  );
  await client.connect(transport);
  return client;
}
