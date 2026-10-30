// A minimal MCP-client side for the flows: dynamic registration, PKCE, the
// authorize URL, the token endpoint and JWT verification against the stage's
// JWKS (jose).
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ISSUER, MCP_URL } from "./env";

export const REDIRECT = "http://127.0.0.1:43110/callback";

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export async function registerClient(name: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ISSUER}/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...extra,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export function authorizeUrl(clientId: string, challenge: string | undefined, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "a2h offline_access",
    state: "e2e-state",
    resource: MCP_URL,
    ...(challenge ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
    ...extra,
  });
  return `${ISSUER}/oauth2/authorize?${p.toString()}`;
}

export async function tokenRequest(form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ISSUER}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export function exchangeCode(clientId: string, code: string, verifier: string) {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: MCP_URL });
}

export function refresh(clientId: string, refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: MCP_URL });
}

const jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks`));

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: MCP_URL });
  return payload;
}
