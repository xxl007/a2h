// SPIKE (m2-org-sign-in task 2.1, issue #127). Throwaway: the app's
// createAuth (src/auth/auth.ts) with the genericOAuth provider `idp` and the
// options design.md D1-D6 name, each switchable so a control run can show the
// difference. Not production code; nothing here is imported by the app.
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth, jwt } from "better-auth/plugins";
import { authSchema, type PrincipalsDb } from "@a2h/db";
import { AUTH_BASE_PATH } from "../../src/config";
import { ROUTES, SCOPES, ACCESS_TOKEN_SECONDS, type Auth } from "../../src/auth/auth";

export const PROVIDER_ID = "idp";
export const SESSION_SECONDS = 12 * 60 * 60;
export const RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface SpikeEvent {
  hook: string;
  [key: string]: unknown;
}

export interface SpikeOptions {
  db: PrincipalsDb;
  /** Raw SQL on the same schema (the spike's `last_idp_sign_in_at` column is not in the Drizzle schema yet). */
  sql: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  baseURL: string;
  mcpUrl: string;
  secret: string;
  /** Absent: no provider plugin (the consent-time instance, D8). */
  idp?: { discoveryUrl: string; clientId: string; clientSecret: string };
  /** D3: refuse unless the claim is true. */
  validate?: boolean;
  emailVerifiedClaim?: string;
  /** D5: database hook that removes the provider's tokens. */
  stripTokens?: boolean;
  /** D4. */
  disableImplicitLinking?: boolean;
  /** D2. */
  disableSocialPath?: boolean;
  /**
   * D6. "global": expiresIn 43200 + disableSessionRefresh.
   * "hook": library defaults (7 days, sliding) and a session.create.before hook that caps provider sessions at 12 h.
   * "hook-norefresh": the same hook, library default lifetime, disableSessionRefresh (no sliding for anyone).
   * "sliding-control": expiresIn 43200, updateAge 0, refresh left on (shows the test detects sliding).
   */
  session?: "global" | "hook" | "hook-norefresh" | "sliding-control";
  /** D6: which hook writes last_idp_sign_in_at. */
  lastSignInWriter?: "after-hook" | "session-db-hook" | "none";
  /** D6: the token endpoint refuses a stale principal (family kept). */
  renewalWindow?: boolean;
  events: SpikeEvent[];
  logLines?: string[];
}

export function createSpikeAuth(o: SpikeOptions): Auth {
  const mode = o.session ?? "global";
  const writer = o.lastSignInWriter ?? "after-hook";
  const claim = o.emailVerifiedClaim ?? "email_verified";
  const strip = <T extends Record<string, unknown>>(account: T) => ({
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  });
  const stamp = async (userId: string) => {
    await o.sql(`update "user" set last_idp_sign_in_at = $1 where id = $2`, [new Date(), userId]);
  };

  const auth = betterAuth({
    appName: "A2H",
    baseURL: o.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: o.secret,
    database: drizzleAdapter(o.db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: false },
    disabledPaths: ["/token", "/sign-in/magic-link", ...(o.disableSocialPath ? ["/sign-in/social"] : [])],
    rateLimit: { enabled: false },
    logger: {
      level: "debug",
      log: (level, message, ...args) => {
        o.logLines?.push(`${level} ${message} ${args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : "")).join(" ")}`.trim());
      },
    },
    telemetry: { enabled: false },
    onAPIError: { errorURL: `${o.baseURL}${ROUTES.signIn}` },
    session:
      mode === "global"
        ? { expiresIn: SESSION_SECONDS, disableSessionRefresh: true }
        : mode === "sliding-control"
          ? { expiresIn: SESSION_SECONDS, updateAge: 0 }
          : mode === "hook-norefresh"
            ? { disableSessionRefresh: true }
            : {},
    account: { accountLinking: o.disableImplicitLinking ? { disableImplicitLinking: true } : {} },
    user: {
      ...(o.validate
        ? {
            validateUserInfo: (data, ctx) => {
              const profile = data.source.oauth?.profile;
              o.events.push({ hook: "validateUserInfo", action: data.source.action, method: data.source.method, providerId: data.source.oauth?.providerId, path: ctx.path, claimKeys: Object.keys(profile ?? {}).sort() });
              if (data.source.method !== "oauth") return;
              const asserted = profile?.[claim];
              if (asserted !== true && asserted !== "true") return { error: "email_not_verified", errorDescription: "the provider did not assert a verified email address" };
              return;
            },
          }
        : {}),
    },
    databaseHooks: {
      account: {
        create: {
          before: (account) => {
            o.events.push({ hook: "account.create.before", hadIdToken: Boolean(account.idToken), hadAccessToken: Boolean(account.accessToken), hadRefreshToken: Boolean(account.refreshToken) });
            return Promise.resolve(o.stripTokens ? { data: strip(account) } : { data: account });
          },
        },
        update: {
          before: (account) => {
            o.events.push({ hook: "account.update.before", keys: Object.keys(account).sort() });
            return Promise.resolve(o.stripTokens ? { data: strip(account) } : { data: account });
          },
        },
      },
      session: {
        create: {
          before: (session, ctx) => {
            o.events.push({ hook: "session.create.before", path: ctx?.path, params: ctx?.params });
            if ((mode === "hook" || mode === "hook-norefresh") && ctx?.path === "/callback/:id") return Promise.resolve({ data: { ...session, expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) } });
            return Promise.resolve({ data: session });
          },
          after: async (session, ctx) => {
            o.events.push({ hook: "session.create.after", path: ctx?.path, params: ctx?.params, userId: session.userId });
            if (writer === "session-db-hook" && ctx?.path === "/callback/:id" && ctx.params?.["id"] === PROVIDER_ID) await stamp(session.userId);
          },
        },
      },
    },
    plugins: [
      {
        id: "a2h-spike-last-idp-sign-in",
        hooks: {
          after: [
            {
              matcher: (ctx) => ctx.path === "/callback/:id",
              handler: createAuthMiddleware(async (ctx) => {
                const created = ctx.context.newSession;
                o.events.push({ hook: "after:/callback/:id", params: ctx.params, newSessionUserId: created?.user.id ?? null, returnedIsError: ctx.context.returned instanceof Error, returnedStatus: (ctx.context.returned as { status?: unknown } | undefined)?.status ?? null });
                if (writer === "after-hook" && created && ctx.params?.["id"] === PROVIDER_ID) await stamp(created.user.id);
              }),
            },
          ],
        },
      },
      jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } }, jwt: { issuer: `${o.baseURL}${AUTH_BASE_PATH}` } }),
      mcp({
        resource: o.mcpUrl,
        loginPage: ROUTES.signIn,
        consentPage: ROUTES.consent,
        scopes: [...SCOPES],
        accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
        refreshTokenReuseInterval: 0,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "native",
        clientRegistrationDefaultResources: [o.mcpUrl],
        grantTypes: ["authorization_code", "refresh_token"],
        customTokenResponseFields: async (info: { grantType: string; user?: { id: string } | null }) => {
          o.events.push({ hook: "customTokenResponseFields", grantType: info.grantType, hasUser: Boolean(info.user) });
          if (!o.renewalWindow || !info.user) return {};
          const { rows } = await o.sql(`select last_idp_sign_in_at from "user" where id = $1`, [info.user.id]);
          const last = rows[0]?.["last_idp_sign_in_at"] as Date | null | undefined;
          if (last && Date.now() - last.getTime() > RENEWAL_WINDOW_MS) {
            throw new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: "the principal must sign in at the identity provider again" });
          }
          return {};
        },
      }),
      cimd({ fetchClientMetadataResource: () => Promise.resolve(new Response("not found", { status: 404 })), metadataProfile: "mcp-2026-07-28" }),
      ...(o.idp
        ? [
            genericOAuth({
              config: [
                {
                  providerId: PROVIDER_ID,
                  discoveryUrl: o.idp.discoveryUrl,
                  requireIdTokenVerification: true,
                  clientId: o.idp.clientId,
                  clientSecret: o.idp.clientSecret,
                  scopes: ["openid", "email", "profile"],
                  pkce: true,
                  overrideUserInfo: true,
                },
              ],
            }),
          ]
        : []),
    ],
  });
  return auth as unknown as Auth;
}
