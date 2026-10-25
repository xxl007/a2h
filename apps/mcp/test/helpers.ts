// Test helpers: run the real HTTP app in-process on an ephemeral port and
// connect the official MCP client to it.
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp, type App, type AppOptions, type LogLine } from "../src/app.ts";

export interface Running {
  app: App;
  origin: string;
  logs: LogLine[];
  stop: () => Promise<void>;
}

export async function start(options: Partial<AppOptions> = {}): Promise<Running> {
  const logs: LogLine[] = [];
  const app = createApp({
    stage: "test",
    mcpBasePath: "/mcp",
    log: (line) => logs.push(line),
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
