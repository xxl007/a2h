// Test helpers: run the real HTTP app in-process on an ephemeral port and
// connect the official MCP client to it.
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { drizzle } from "drizzle-orm/node-postgres";
import { createApp, type A2hOptions, type App, type AppOptions, type LogLine } from "../src/app.ts";

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
    principal: { principal_id: "dev-principal-test", identity_mode: "verified_organisation", verified: true },
    policy: {
      fee_rate: 0.2,
      currency: "EUR",
      monthly_budget_minor: 50_000,
      per_request_cap_minor: 6_000,
      ask_first_above_minor: null,
      daily_request_limit: 50,
      throttled_daily_limit: 5,
    },
    clearingShare: 0.5,
    approvalKey: new Uint8Array(32).fill(1),
  };
}

/** The real HTTP app with the A2H tools (offline unless `a2h` is given). */
export async function start(options: Partial<AppOptions> = {}): Promise<Running> {
  const logs: LogLine[] = [];
  const app = createApp({
    stage: "test",
    mcpBasePath: "/mcp",
    log: (line) => logs.push(line),
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
