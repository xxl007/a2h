// Target of the live suites (MCP contract tests, web e2e): read from the
// environment, never hard-coded, so the same tests run against any stage.
// Spec: openspec/changes/m0-foundation/specs/platform/mcp-transport/spec.md.

const STAGE_FROM_PATH = /^\/(pr-[1-9][0-9]*)\/mcp\/?$/;
const DEV_PATH = /^\/mcp\/?$/;

/** Reads a required variable, or throws a message that says how to set it. */
export function requireEnv(name: string, example: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. These tests run against a live stage; set it, e.g. ${name}=${example}. ` +
        "For a preview, take the URL from the PR's preview comment (see tests/README.md).",
    );
  }
  return value;
}

export function mcpUrl(): URL {
  const raw = requireEnv("A2H_MCP_URL", "http://<alb-dns>/pr-<n>/mcp");
  const url = new URL(raw);
  if (!STAGE_FROM_PATH.test(url.pathname) && !DEV_PATH.test(url.pathname)) {
    throw new Error(`A2H_MCP_URL path must be /mcp or /pr-<n>/mcp, got ${url.pathname}`);
  }
  return url;
}

/**
 * Stage the server is expected to report. A2H_STAGE wins; otherwise
 * `/pr-<n>/mcp` means `pr-<n>` and `/mcp` means `dev` (prod also serves
 * `/mcp`: set A2H_STAGE=prod there).
 */
export function expectedStage(url: URL = mcpUrl()): string {
  const explicit = process.env.A2H_STAGE?.trim();
  if (explicit) return explicit;
  const match = STAGE_FROM_PATH.exec(url.pathname);
  return match?.[1] ?? "dev";
}

/** Health path at the same prefix as the MCP path: `/mcp` -> `/healthz`, `/pr-<n>/mcp` -> `/pr-<n>/healthz`. */
export function healthUrl(url: URL = mcpUrl()): URL {
  const health = new URL(url);
  health.pathname = url.pathname.replace(/\/mcp\/?$/, "/healthz");
  health.search = "";
  return health;
}

// ---- m1-hosted-connector: tokens, hostnames and the gate's expected state ----
// The expectations come from the same source as the deployment (infra/config.ts
// publicUrls, infra/service-env.ts plainEnvironment), never from a copy here.

/** The signed-in principal's access token (A2H_TOKEN, from tests/lib/obtain-token.ts). Undefined: the suites run tokenless (gate off). */
export function bearerToken(): string | undefined {
  return process.env["A2H_TOKEN"]?.trim() || undefined;
}

/** A second principal's token (A2H_TOKEN_2): the "another account" of the specs. */
export function secondToken(): string | undefined {
  return process.env["A2H_TOKEN_2"]?.trim() || undefined;
}

/** A token of the first principal without the `a2h` scope (A2H_TOKEN_NOSCOPE), when the sign-in step could mint one. */
export function noScopeToken(): string | undefined {
  return process.env["A2H_TOKEN_NOSCOPE"]?.trim() || undefined;
}

/** The web URL of the stage under test: A2H_WEB_URL, else derived from the product domain. */
export async function webUrl(stage: string = expectedStage()): Promise<string> {
  const explicit = process.env["A2H_WEB_URL"]?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const { domain, publicUrls, stageInfo } = await import("../../infra/config.ts");
  if (!domain) throw new Error("A2H_WEB_URL is not set and infra/config.ts has no domain");
  return publicUrls(stageInfo(stage), domain).web;
}

/** The stage's authorization server (design D1): `<web URL>/api/auth`. */
export async function issuer(stage: string = expectedStage()): Promise<string> {
  return `${await webUrl(stage)}/api/auth`;
}

/** The development stage's MCP URL (the "other stage" of "Preview tokens stay on the preview"). */
export async function devMcpUrl(): Promise<URL> {
  const { domain, publicUrls, stageInfo } = await import("../../infra/config.ts");
  if (!domain) throw new Error("infra/config.ts has no domain");
  return new URL(publicUrls(stageInfo("dev"), domain).mcp);
}

/** `<origin>/.well-known/oauth-protected-resource<mcp path>` (RFC 9728, path-aware). */
export function metadataUrl(url: URL = mcpUrl()): URL {
  const out = new URL(url);
  out.pathname = `/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, "")}`;
  out.search = "";
  return out;
}

export interface GateExpectation {
  /** AUTH_REQUIRED on the mcp service of this stage. */
  authRequired: boolean;
  /** PING_OPEN: the handshake, tools/list and `ping` admitted without a token. */
  pingOpen: boolean;
}

/** What infra configures for the stage's gate (infra/service-env.ts), so the live tests assert the deployed state, not a wish. */
export async function gateExpectation(stage: string = expectedStage()): Promise<GateExpectation> {
  const { stageInfo } = await import("../../infra/config.ts");
  const { plainEnvironment } = await import("../../infra/service-env.ts");
  const env = plainEnvironment("mcp", stageInfo(stage));
  return { authRequired: env["AUTH_REQUIRED"] === "true", pingOpen: env["PING_OPEN"] === "true" };
}
