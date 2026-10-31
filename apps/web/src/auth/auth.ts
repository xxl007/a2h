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
// Users and sessions are created for allow-listed addresses only (database
// hooks), so a link minted before an address left the list cannot sign in.
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, magicLink } from "better-auth/plugins";
import type { PrincipalsDb } from "@a2h/db";
import { authSchema } from "@a2h/db";
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
