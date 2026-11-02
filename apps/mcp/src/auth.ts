// The MCP endpoint as an OAuth 2.1 resource server (m1-hosted-connector
// design D3; spec platform/connector-authorization). Tokens are signed JWTs
// from the stage's authorization server (Better Auth in apps/web), verified
// here against its published keys: issuer, audience (exactly the stage's MCP
// URL), expiry, scope. The JWKS is cached (10 min) and refetched at most once
// a minute for an unknown key; no call to the authorization server happens
// per request. The subject is the principal id; nothing else of the token is
// kept, and the token itself is never logged, stored or forwarded (D10).
//
// Sources: @modelcontextprotocol/server 2.4.0 dist/index.d.mts
// (requireBearerAuth, oauthMetadataResponse, OAuthTokenVerifier, AuthInfo)
// and jose 6 (createRemoteJWKSet, jwtVerify).
import {
  type AuthInfo,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

/** The scope every A2H tool needs (the protected-resource metadata lists it alone). */
export const A2H_SCOPE = "a2h";
/** Refetch the JWKS for an unknown key at most once a minute (spec "Tokens are verified locally…"). */
export const JWKS_COOLDOWN_MS = 60_000;
/** Keys are trusted from cache for ten minutes (design D3). */
export const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
/** Signature algorithms accepted (Better Auth's `jwt` plugin signs with EdDSA by default). */
export const ACCEPTED_ALGORITHMS = ["EdDSA", "ES256", "RS256"];

export interface AuthConfig {
  /** false: the gate is off (AUTH_REQUIRED=false, dev and previews only, Migration Plan rollback). */
  required: boolean;
  /** The stage's authorization server, `https://<web host>/api/auth` (AUTH_ISSUER). */
  issuer: string;
  /** Its keys (AUTH_JWKS_URL). */
  jwksUrl: string;
  /** The stage's MCP URL: the only audience accepted (MCP_RESOURCE_URL). */
  resourceUrl: string;
  /**
   * true: the handshake, tools/list and `ping` are admitted without a token
   * (PING_OPEN). Off on every deployed stage since m1-hosted-connector task
   * 8.3 (infra/service-env.ts PING_OPEN_BY_STAGE_KIND): the verify jobs carry
   * a token and hosted clients must meet the 401 on the handshake.
   */
  pingOpen: boolean;
}

/** Who is calling: the principal id is the token's subject (never a deployment value), the client its `azp`/`client_id`. */
export interface Caller {
  principal_id: string;
  client_id?: string | undefined;
}

function invalid(): never {
  // One message for every failure: the response says nothing about why.
  throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired token");
}

function scopesOf(payload: Record<string, unknown>): string[] {
  const { scope, scp } = payload;
  if (typeof scope === "string") return scope.split(" ").filter((s) => s !== "");
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === "string");
  return [];
}

/** The JWT verifier of the gate (OAuthTokenVerifier). */
export function jwtVerifier(config: Pick<AuthConfig, "issuer" | "jwksUrl" | "resourceUrl">): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), { cooldownDuration: JWKS_COOLDOWN_MS, cacheMaxAge: JWKS_CACHE_MAX_AGE_MS });
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer: config.issuer, algorithms: ACCEPTED_ALGORITHMS, requiredClaims: ["exp", "sub"] }));
      } catch {
        invalid();
      }
      // Audience: exactly the stage's MCP URL (no trailing-slash or prefix leniency).
      const aud = payload["aud"];
      const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
      if (!audiences.includes(config.resourceUrl)) invalid();
      const sub = payload["sub"];
      const exp = payload["exp"];
      if (typeof sub !== "string" || sub === "" || typeof exp !== "number") invalid();
      const clientId = typeof payload["client_id"] === "string" ? payload["client_id"] : typeof payload["azp"] === "string" ? payload["azp"] : "";
      return {
        token,
        clientId,
        scopes: scopesOf(payload),
        expiresAt: exp,
        resource: new URL(config.resourceUrl),
        extra: { principal_id: sub },
      };
    },
  };
}

/** The caller a verified token stands for. */
export function callerOf(authInfo: AuthInfo | undefined): Caller | undefined {
  const id = authInfo?.extra?.["principal_id"];
  if (typeof id !== "string" || id === "") return undefined;
  return { principal_id: id, client_id: authInfo?.clientId || undefined };
}

/** What may be reached without a token when PING_OPEN is true: the handshake, the tool list, protocol ping and the `ping` tool. */
const OPEN_METHODS = new Set(["initialize", "notifications/initialized", "server/discover", "tools/list", "ping"]);

function isOpenMessage(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (typeof method !== "string") return false;
  if (OPEN_METHODS.has(method)) return true;
  return method === "tools/call" && typeof params === "object" && params !== null && (params as { name?: unknown }).name === "ping";
}

export type GateOutcome = { ok: true; authInfo?: AuthInfo; parsedBody?: unknown } | { ok: false; response: Response };

export interface Gate {
  /** `/.well-known/oauth-protected-resource<mcp path>` */
  metadataPath: string;
  /** The protected-resource metadata response, or undefined if `request` is not for it. */
  metadata: (request: Request) => Promise<Response | undefined>;
  /** Admit or challenge a request to the MCP path. */
  check: (request: Request) => Promise<GateOutcome>;
}

export function createGate(config: AuthConfig, verifier: OAuthTokenVerifier = jwtVerifier(config)): Gate {
  const resource = new URL(config.resourceUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const metadataPath = new URL(resourceMetadataUrl).pathname;
  const metadataOptions = {
    // Only `issuer` is read for the protected-resource document; the
    // authorization server's own metadata is served by the issuer, never here.
    oauthMetadata: {
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/oauth2/authorize`,
      token_endpoint: `${config.issuer}/oauth2/token`,
      response_types_supported: ["code"],
    },
    resourceServerUrl: resource,
    scopesSupported: [A2H_SCOPE],
  };
  const bearer = requireBearerAuth({ verifier, requiredScopes: [A2H_SCOPE], resourceMetadataUrl, expectedResource: resource });
  // RFC 6750 §3.1: a request without credentials gets the challenge without an error code, and no body.
  const bare = () =>
    new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="${A2H_SCOPE}"` } });

  return {
    metadataPath,
    async metadata(request) {
      if (new URL(request.url).pathname !== metadataPath) return undefined;
      const response = oauthMetadataResponse(request, metadataOptions);
      if (!response || request.method !== "GET" || response.status !== 200) return response;
      // RFC 9728 `bearer_methods_supported`, which the SDK's document omits.
      const doc = (await response.json()) as Record<string, unknown>;
      return Response.json({ ...doc, bearer_methods_supported: ["header"] }, { status: 200, headers: response.headers });
    },
    async check(request) {
      if (!config.required) return { ok: true };
      if (request.headers.get("authorization") === null) {
        if (config.pingOpen && request.method === "POST") {
          let body: unknown;
          try {
            body = await request.clone().json();
          } catch {
            return { ok: false, response: bare() };
          }
          if (isOpenMessage(body)) return { ok: true, parsedBody: body };
        }
        return { ok: false, response: bare() };
      }
      const outcome = await bearer(request);
      return outcome instanceof Response ? { ok: false, response: outcome } : { ok: true, authInfo: outcome };
    },
  };
}
