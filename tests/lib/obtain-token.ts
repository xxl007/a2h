// Sign a test principal in through the stage's mail sink and obtain an access
// token for the stage's MCP endpoint (m1-hosted-connector task 8.3). The
// verify jobs run this before the contract and adversarial suites, so those
// act as a signed-in principal (A2H_TOKEN) and as a second one (A2H_TOKEN_2).
//
// Flow, as a hosted client does it: the client id is the preview's own
// Client ID Metadata Document on https stages (no registration, spec
// "Metadata-document client"), dynamic registration elsewhere; PKCE S256;
// the authorize URL lands on /sign-in; the address is typed; the link is
// read from the sink (tests/lib/mail-sink.ts); following it resumes the
// authorization; the consent is accepted; the code comes back on the
// loopback redirect, which Playwright answers; the code is exchanged; the
// token is verified against the stage's JWKS before anything is written.
//
// Output: with GITHUB_ENV set, `::add-mask::` for each token on stdout, then
// the variables appended to $GITHUB_ENV; otherwise the lines go to the file
// named by --out (mode 0600). Nothing else prints a token or an address.
//
// Environment: A2H_WEB_URL, A2H_MCP_URL, A2H_STAGE (default from the MCP
// path), A2H_TEST_EMAIL (principal A), A2H_TEST_EMAIL_2 (principal B,
// optional), A2H_MAIL_SINK_BUCKET or A2H_MAIL_SINK_DIR.
// Run: pnpm --filter @a2h/tests obtain-token -- --out /path/tokens.env
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { expectedStage, mcpUrl, requireEnv } from "../src/live-env.ts";
import { sinkClientFromEnv, waitForMagicLink, type SinkObjectClient } from "./mail-sink.ts";
import {
  ALL_SCOPES,
  authorizeUrl,
  cimdClientId,
  exchangeCode,
  githubEnvLines,
  LOOPBACK_REDIRECT,
  parseCallback,
  pkce,
  registerClient,
  scopesOf,
  verifyAccessToken,
} from "./oauth-client.ts";

export interface SignInTarget {
  webUrl: string;
  mcpUrl: string;
  stage: string;
  sink: SinkObjectClient;
}

export interface Grant {
  accessToken: string;
  refreshToken: string | undefined;
  clientId: string;
  /** The token's subject: the principal id. */
  principalId: string;
  scopes: string[];
  expiresAt: number;
}

export const issuerOf = (webUrl: string): string => `${webUrl.replace(/\/$/, "")}/api/auth`;

/** The client id the flows use: the stage's own metadata document on https, a dynamic registration otherwise. */
export async function clientIdFor(webUrl: string): Promise<{ clientId: string; registration: "metadata-document" | "dynamic" }> {
  if (webUrl.startsWith("https://")) return { clientId: cimdClientId(webUrl), registration: "metadata-document" };
  const reg = await registerClient(issuerOf(webUrl), "A2H QA verify client");
  const clientId = reg.body["client_id"];
  if (reg.status !== 201 || typeof clientId !== "string") throw new Error(`dynamic registration failed: HTTP ${reg.status}`);
  return { clientId, registration: "dynamic" };
}

const STEP_TIMEOUT_MS = 30_000;

/**
 * One authorization in a fresh browser context: sign-in (when the context
 * holds no session), consent (when not yet given for the client), code, token.
 */
export async function obtainToken(
  browser: Browser,
  target: SignInTarget,
  email: string,
  options: { clientId: string; scope?: string; context?: BrowserContext },
): Promise<Grant> {
  const issuer = issuerOf(target.webUrl);
  const context = options.context ?? (await browser.newContext());
  const page = await context.newPage();
  let callback: URL | undefined;
  await page.route(`${LOOPBACK_REDIRECT}**`, async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/plain", body: "A2H QA client callback" });
  });
  try {
    const { verifier, challenge } = pkce();
    const state = pkce().verifier.slice(0, 16);
    await page.goto(authorizeUrl(issuer, { clientId: options.clientId, resource: target.mcpUrl, challenge, state, scope: options.scope ?? ALL_SCOPES }), {
      waitUntil: "load",
      timeout: STEP_TIMEOUT_MS,
    });
    const deadline = Date.now() + 3 * STEP_TIMEOUT_MS;
    while (!callback) {
      if (Date.now() > deadline) throw new Error(`authorization did not reach the client callback; last page: ${new URL(page.url()).pathname}`);
      const path = new URL(page.url()).pathname;
      if (path === "/sign-in") {
        const since = new Date();
        await page.getByLabel("Email address").fill(email);
        await page.getByRole("button", { name: "Email me a sign-in link" }).click();
        await page.waitForURL(/\/sign-in\/sent/, { timeout: STEP_TIMEOUT_MS });
        const link = await waitForMagicLink(target.sink, target.stage, email, since, { timeoutMs: STEP_TIMEOUT_MS });
        await page.goto(link, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
        continue;
      }
      if (path === "/sign-in/expired") throw new Error("the magic link was refused as expired or used");
      if (path === "/consent") {
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await page.waitForLoadState("load", { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
        continue;
      }
      await page.waitForTimeout(250);
    }
    const cb = parseCallback(callback);
    if (cb.error) throw new Error(`authorization refused: ${cb.error}`);
    if (cb.state !== state) throw new Error("the callback's state does not match the request");
    if (cb.iss !== issuer) throw new Error("the callback carries no iss, or another issuer");
    if (!cb.code) throw new Error("the callback carries no code");
    const tokens = await exchangeCode(issuer, { clientId: options.clientId, code: cb.code, verifier, resource: target.mcpUrl });
    const accessToken = tokens.body["access_token"];
    if (tokens.status !== 200 || typeof accessToken !== "string") throw new Error(`token exchange failed: HTTP ${tokens.status} ${typeof tokens.body["error"] === "string" ? tokens.body["error"] : ""}`);
    const claims = await verifyAccessToken(issuer, accessToken, target.mcpUrl);
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("the access token has no subject");
    const refresh = tokens.body["refresh_token"];
    return {
      accessToken,
      refreshToken: typeof refresh === "string" ? refresh : undefined,
      clientId: options.clientId,
      principalId: claims.sub,
      scopes: scopesOf(claims),
      expiresAt: claims.exp ?? 0,
    };
  } finally {
    await page.close().catch(() => undefined);
    if (!options.context) await context.close().catch(() => undefined);
  }
}

export interface Obtained {
  A2H_TOKEN: string;
  A2H_TOKEN_2?: string;
  A2H_TOKEN_NOSCOPE?: string;
}

/** Principal A (both scopes), principal B when given, and A again without `a2h` when the server lets a subset through. */
export async function obtainAll(browser: Browser, target: SignInTarget, emails: { a: string; b?: string }, log: (line: string) => void): Promise<Obtained> {
  const { clientId, registration } = await clientIdFor(target.webUrl);
  log(`client: ${registration} (${clientId})`);
  const a = await obtainToken(browser, target, emails.a, { clientId });
  log(`principal A: sub ${a.principalId}, scopes [${a.scopes.join(" ")}], expires in ${a.expiresAt - Math.floor(Date.now() / 1000)} s`);
  if (!a.scopes.includes("a2h")) throw new Error("principal A's token lacks the a2h scope");
  const out: Obtained = { A2H_TOKEN: a.accessToken };
  if (emails.b) {
    const b = await obtainToken(browser, target, emails.b, { clientId });
    log(`principal B: sub ${b.principalId}, scopes [${b.scopes.join(" ")}]`);
    if (b.principalId === a.principalId) throw new Error("the two addresses map to one principal");
    out.A2H_TOKEN_2 = b.accessToken;
  }
  try {
    // Same account, `offline_access` only: a token the resource server must answer with 403 insufficient_scope.
    const context = await browser.newContext();
    try {
      const signedIn = await obtainToken(browser, target, emails.a, { clientId, context });
      void signedIn;
      const noScope = await obtainToken(browser, target, emails.a, { clientId, scope: "offline_access", context });
      if (noScope.scopes.includes("a2h")) log("no-scope token: the server granted a2h anyway; A2H_TOKEN_NOSCOPE not written");
      else {
        out.A2H_TOKEN_NOSCOPE = noScope.accessToken;
        log(`no-scope token: scopes [${noScope.scopes.join(" ")}]`);
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (e) {
    log(`no-scope token not obtained (${(e as Error).message}); the Missing scope scenario runs in-process only`);
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : undefined;
  const githubEnv = process.env["GITHUB_ENV"];
  if (!out && !githubEnv) throw new Error("pass --out <file> (or run under GitHub Actions, where GITHUB_ENV is set)");
  const target: SignInTarget = {
    webUrl: requireEnv("A2H_WEB_URL", "https://pr-<n>.dev.a2h-protocol.org").replace(/\/$/, ""),
    mcpUrl: mcpUrl().href,
    stage: expectedStage(),
    sink: sinkClientFromEnv().client,
  };
  const a = requireEnv("A2H_TEST_EMAIL", "qa-principal-a@a2h-protocol.org");
  const b = process.env["A2H_TEST_EMAIL_2"]?.trim() || undefined;
  const log = (line: string) => process.stdout.write(`obtain-token: ${line}\n`);
  log(`stage ${target.stage}, web ${target.webUrl}, resource ${target.mcpUrl}`);
  const browser = await chromium.launch();
  try {
    const tokens = await obtainAll(browser, target, b ? { a, b } : { a }, log);
    const { masks, env } = githubEnvLines(tokens as unknown as Record<string, string>);
    if (githubEnv) {
      for (const m of masks) process.stdout.write(`${m}\n`);
      appendFileSync(githubEnv, env);
      log(`wrote ${Object.keys(tokens).join(", ")} to GITHUB_ENV (masked)`);
    } else {
      writeFileSync(out!, env, { mode: 0o600 });
      log(`wrote ${Object.keys(tokens).join(", ")} to ${out}`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`obtain-token: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
