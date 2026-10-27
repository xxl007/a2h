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
