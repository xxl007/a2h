// A minimal OAuth 2.1 client side for the live suites (m1-hosted-connector
// tasks 8.3, 9.1, 9.2): PKCE, the authorize URL, dynamic registration, the
// token endpoint, the Client ID Metadata Document a preview serves for its
// own tests, token inspection against the stage's JWKS (jose), and the
// GitHub Actions lines that hand tokens to later steps masked. Pure where it
// can be (tested in oauth-client.test.ts); the network calls take the issuer.
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { FIXTURE_PATH, FIXTURE_REDIRECT } from "../../apps/web/src/auth/test-fixtures.ts";

/** The loopback redirect every test client uses: no server listens; Playwright or the caller answers it. */
export const LOOPBACK_REDIRECT = FIXTURE_REDIRECT;
/** The scopes the authorization server offers (apps/web/src/auth/auth.ts SCOPES). */
export const ALL_SCOPES = "a2h offline_access";

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256: challenge = base64url(sha256(verifier)). */
export function pkce(randomBytes: (n: number) => Uint8Array = (n) => nodeRandomBytes(n)): Pkce {
  const verifier = Buffer.from(randomBytes(32)).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface AuthorizeParams {
  clientId: string;
  resource: string;
  redirect?: string;
  scope?: string;
  state?: string;
  /** Omit for the "PKCE missing" scenario. */
  challenge?: string | undefined;
  /** Default S256; "plain" for the refusal scenario. */
  challengeMethod?: string;
  extra?: Record<string, string>;
}

export function authorizeUrl(issuer: string, p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirect ?? LOOPBACK_REDIRECT,
    scope: p.scope ?? ALL_SCOPES,
    state: p.state ?? "a2h-tests",
    resource: p.resource,
    ...(p.challenge !== undefined ? { code_challenge: p.challenge, code_challenge_method: p.challengeMethod ?? "S256" } : {}),
    ...(p.extra ?? {}),
  });
  return `${issuer}/oauth2/authorize?${q.toString()}`;
}

/** A preview serves its own metadata document for the CIMD tests (apps/web/src/auth/test-fixtures.ts; https stages only). */
export function cimdClientId(webUrl: string, name = "match.json"): string {
  return `${webUrl.replace(/\/$/, "")}${FIXTURE_PATH}/${name}`;
}

export interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  iss?: string;
}

/** What the authorization server put on the redirect back to the client. */
export function parseCallback(url: URL | string): CallbackResult {
  const u = typeof url === "string" ? new URL(url) : url;
  const get = (k: string) => u.searchParams.get(k) ?? undefined;
  const out: CallbackResult = {};
  const code = get("code");
  const state = get("state");
  const error = get("error");
  const description = get("error_description");
  const iss = get("iss");
  if (code !== undefined) out.code = code;
  if (state !== undefined) out.state = state;
  if (error !== undefined) out.error = error;
  if (description !== undefined) out.errorDescription = description;
  if (iss !== undefined) out.iss = iss;
  return out;
}

export interface HttpJson {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

async function postJson(url: string, body: unknown): Promise<HttpJson> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** RFC 7591 dynamic registration of a public client with the loopback redirect. */
export function registerClient(issuer: string, name: string, extra: Record<string, unknown> = {}): Promise<HttpJson> {
  return postJson(`${issuer}/oauth2/register`, {
    client_name: name,
    redirect_uris: [LOOPBACK_REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...extra,
  });
}

export async function tokenRequest(issuer: string, form: Record<string, string>): Promise<HttpJson> {
  const res = await fetch(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export function exchangeCode(issuer: string, p: { clientId: string; code: string; verifier: string; resource: string; redirect?: string }): Promise<HttpJson> {
  return tokenRequest(issuer, {
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirect ?? LOOPBACK_REDIRECT,
    client_id: p.clientId,
    code_verifier: p.verifier,
    resource: p.resource,
  });
}

export function refreshGrant(issuer: string, p: { clientId: string; refreshToken: string; resource: string }): Promise<HttpJson> {
  return tokenRequest(issuer, { grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId, resource: p.resource });
}

/** Claims without verification (for assertions on a token the suite already trusts). */
export function claimsOf(token: string): JWTPayload {
  return decodeJwt(token);
}

/** Verifies `token` against `<issuer>/jwks` for `resource`; throws when it does not verify. */
export async function verifyAccessToken(issuer: string, token: string, resource: string): Promise<JWTPayload> {
  const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`));
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: resource });
  return payload;
}

/** Space-separated `scope` or `scp` array, as the resource server reads them. */
export function scopesOf(claims: JWTPayload): string[] {
  const { scope, scp } = claims as { scope?: unknown; scp?: unknown };
  if (typeof scope === "string") return scope.split(" ").filter((s) => s !== "");
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === "string");
  return [];
}

/**
 * Lines for $GITHUB_ENV (name=value) and the `::add-mask::` commands that
 * must be printed first, so a token never appears in a log. Values with a
 * newline are refused (they would need the heredoc form and never occur here).
 */
export function githubEnvLines(values: Record<string, string>): { masks: string[]; env: string } {
  const masks: string[] = [];
  const lines: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`not an environment name: ${name}`);
    if (/[\r\n]/.test(value)) throw new Error(`${name}: a value must be one line`);
    masks.push(`::add-mask::${value}`);
    lines.push(`${name}=${value}`);
  }
  return { masks, env: lines.map((l) => `${l}\n`).join("") };
}
