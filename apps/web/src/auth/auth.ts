// The stage's OAuth 2.1 authorization server (design D1, D8; spec
// platform/principal-identity): Better Auth 1.7 at /api/auth with
//   - jwt: EdDSA keys in `jwks`, published at /api/auth/jwks; access tokens
//     are JWTs whose `iss` is the issuer and `aud` the requested resource;
//   - mcp (@better-auth/mcp, the OAuth provider configured for MCP: Better
//     Auth's docs present it as built on @better-auth/oauth-provider, not
//     deprecated): resource = the stage's MCP URL, scopes `a2h` and
//     `offline_access`, PKCE required, refresh tokens rotated with no reuse
//     window (a replay revokes the family), DCR open with `native` as the
//     default application type;
//   - cimd: Client ID Metadata Documents, MCP 2026-07-28 profile, fetched by
//     the SSRF-hardened Node transport (no loopback, private or link-local);
//   - magicLink: 15 minutes, single use, token stored hashed. Its HTTP
//     endpoint is disabled: the only way to ask for a link is the sign-in
//     server action, which checks the allow-list first (D7) and stays neutral.
// The allow-list decides whether a principal may act now (design D4, ADR 0004
// decision 2; spec scenario "Address removed from the allow-list"), through
// the same cached reader (five-minute refresh) at every step:
//   - users and sessions are created for allow-listed addresses only
//     (database hooks), so a link minted before removal cannot sign in;
//   - every Better Auth call that reads a session, over HTTP or through
//     `auth.api` (pages, server actions, authorize, consent), first re-checks
//     the session's address: a removed one has all its sessions revoked and
//     the cookie cleared, so the call sees no session (`allowlistGate`);
//   - the token endpoint refuses any grant for a removed address and revokes
//     every live refresh token of that principal (`refuseRemovedPrincipal`).
// Access tokens already issued live to their own expiry (one hour at most).
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { jwt, magicLink } from "better-auth/plugins";
import type { PrincipalsDb } from "@a2h/db";
import { and, authSchema, eq, isNull, oauthRefreshToken } from "@a2h/db";
import { AUTH_BASE_PATH, type WebConfig } from "../config";
import { betterAuthLog, type Logger } from "../log";

export const SCOPES = ["a2h", "offline_access"] as const;
export type A2hScope = (typeof SCOPES)[number];
/** The scope the MCP endpoint requires (spec connector-authorization). */
export const RESOURCE_SCOPE = "a2h";
export const MAGIC_LINK_MINUTES = 15;
export const ACCESS_TOKEN_SECONDS = 3600;

export const ROUTES = {
  signIn: "/sign-in",
  sent: "/sign-in/sent",
  expired: "/sign-in/expired",
  consent: "/consent",
  clients: "/account/clients",
  signedOut: "/signed-out",
} as const;

export interface AuthDeps {
  /** Any Drizzle Postgres database: the Data API one on AWS, node-postgres in tests. */
  db: PrincipalsDb;
  config: Pick<WebConfig, "baseURL" | "issuer" | "mcpUrl" | "secret">;
  /** Delivers the magic link (mail sink or SES). Never logs the address or the URL. */
  sendMagicLink: (email: string, url: string) => Promise<void>;
  /** Allow-list check (D7). */
  isAllowed: (email: string) => Promise<boolean>;
  logger: Logger;
  /** CIMD transport; the Node transport by default (tests inject one). */
  fetchClientMetadata?: ClientMetadataResourceFetch;
  /** Better Auth's own HTTP rate limiter (in-memory per instance); on by default. */
  rateLimit?: boolean;
}

/**
 * Re-checks the address of the session a call carries, before the endpoint
 * runs. A removed address: every session of that user is deleted, the session
 * cookie is cleared and the call proceeds signed out. The endpoint's own
 * session read then finds nothing (the cached read is reset to null).
 */
export function allowlistGate(isAllowed: AuthDeps["isAllowed"], logger: Logger): BetterAuthPlugin {
  return {
    id: "a2h-allowlist-gate",
    hooks: {
      before: [
        {
          // Only calls that can carry a session cookie; the token endpoint and
          // metadata reads from clients carry none.
          matcher: (ctx) => Boolean(ctx.headers?.get("cookie")),
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx);
            if (!current || (await isAllowed(current.user.email))) return;
            await ctx.context.internalAdapter.deleteUserSessions(current.user.id);
            deleteSessionCookie(ctx);
            ctx.context.session = null;
            logger.warn("session revoked: address no longer allowed", { code: "session_not_allowed", principal_id: current.user.id });
          }),
        },
      ],
    },
  };
}

/**
 * Called by the OAuth provider before it mints tokens for a user (the
 * `authorization_code` and `refresh_token` grants; `customTokenResponseFields`
 * runs before any token is created or rotated). A removed address: every
 * live refresh token of the principal is revoked and the grant is refused
 * with `invalid_grant`, so the client must go through sign-in again.
 */
export function refuseRemovedPrincipal(deps: Pick<AuthDeps, "db" | "isAllowed" | "logger">) {
  return async (info: { grantType: string; user?: { id: string; email: string } | null }): Promise<Record<string, never>> => {
    const { user } = info;
    if (!user || (await deps.isAllowed(user.email))) return {};
    await deps.db
      .update(oauthRefreshToken)
      .set({ revoked: new Date() })
      .where(and(eq(oauthRefreshToken.userId, user.id), isNull(oauthRefreshToken.revoked)));
    deps.logger.warn("token grant refused: address no longer allowed", { code: info.grantType === "refresh_token" ? "refresh_not_allowed" : "grant_not_allowed", principal_id: user.id });
    throw new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: "the principal may no longer use this stage" });
  };
}

export function createAuth(deps: AuthDeps) {
  const { config, logger } = deps;
  return betterAuth({
    appName: "A2H",
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database: drizzleAdapter(deps.db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: false },
    // `/token` is the jwt plugin's session-to-JWT endpoint: OAuth clients get
    // tokens from /oauth2/token only. `/sign-in/magic-link` is reached through
    // the sign-in server action only (allow-list first).
    disabledPaths: ["/token", "/sign-in/magic-link"],
    rateLimit: { enabled: deps.rateLimit ?? true },
    logger: { level: "info", log: betterAuthLog(logger) },
    telemetry: { enabled: false },
    advanced: {
      useSecureCookies: config.baseURL.startsWith("https://"),
      // CloudFront appends the viewer's address to X-Forwarded-For. Better
      // Auth's limiter is per Lambda instance and in memory; the edge limit
      // (WAF, task 8.1) is the one that holds across instances.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await deps.isAllowed(user.email))) {
              logger.warn("sign-in refused: address not allowed", { code: "user_not_allowed" });
              return false;
            }
            return { data: user };
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const found = await ctx?.context.internalAdapter.findUserById(session.userId);
            if (!found || !(await deps.isAllowed(found.email))) {
              logger.warn("sign-in refused: address not allowed", { code: "session_not_allowed" });
              return false;
            }
            return { data: session };
          },
        },
      },
    },
    plugins: [
      allowlistGate(deps.isAllowed, logger),
      jwt({
        jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
        jwt: { issuer: config.issuer },
      }),
      mcp({
        resource: config.mcpUrl,
        loginPage: ROUTES.signIn,
        consentPage: ROUTES.consent,
        scopes: [...SCOPES],
        accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
        // Spec "Refresh token replayed": any reuse of a rotated refresh token
        // revokes its family (the mcp plugin's default would allow 30 s).
        refreshTokenReuseInterval: 0,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "native",
        clientRegistrationDefaultResources: [config.mcpUrl],
        grantTypes: ["authorization_code", "refresh_token"],
        // Not a response field: the allow-list check of the token endpoint (see refuseRemovedPrincipal).
        customTokenResponseFields: refuseRemovedPrincipal(deps),
      }),
      cimd({
        fetchClientMetadataResource: deps.fetchClientMetadata ?? fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
      magicLink({
        expiresIn: MAGIC_LINK_MINUTES * 60,
        storeToken: "hashed",
        // Per address and minute, for asking (server action, not limited here)
        // and following links; generous enough for a test suite from one address.
        rateLimit: { window: 60, max: 30 },
        sendMagicLink: async ({ email, url }) => {
          await deps.sendMagicLink(email, url);
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
