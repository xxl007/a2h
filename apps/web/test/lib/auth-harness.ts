// The authorization server in-process on a throwaway Postgres schema, driven
// over HTTP through `auth.handler` like a browser and an MCP client would
// (cookie jar, PKCE). Same factory as the deployed app (src/auth/auth.ts),
// with the database on node-postgres and the CIMD transport stubbed (the
// real transport is tested on its own and on the preview).
import { createHash, randomBytes } from "node:crypto";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { Allowlist } from "../../src/auth/allowlist";
import { createAuth, type Auth, type AuthDeps } from "../../src/auth/auth";
import { createLogger, type Logger } from "../../src/log";
import type { PrincipalsDb } from "@a2h/db";
import { createStageSchema } from "./postgres";

export const BASE = "http://localhost:3000";
export const ISSUER = `${BASE}/api/auth`;
export const MCP = "http://localhost:3001/mcp";
export const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
export const ALLOWED = "principal@example.com";
export const SECOND = "second@example.com";
export const POLICY = {
  currency: "EUR",
  monthly_budget_minor: 50_000,
  per_request_cap_minor: 6_000,
  ask_first_above_minor: null,
  daily_request_limit: 50,
  throttled_daily_limit: 5,
};

export interface Mail {
  email: string;
  url: string;
}

export interface Harness {
  pool: pg.Pool;
  db: PrincipalsDb;
  auth: Auth;
  authOn: (db: AuthDeps["db"]) => Auth;
  mail: Mail[];
  logLines: string[];
  logger: Logger;
  cimd: Map<string, unknown>;
  /** Every URL the CIMD transport was asked to fetch. */
  cimdFetches: string[];
  isAllowed: (email: string) => Promise<boolean>;
  close(): Promise<void>;
}

export async function startHarness(adminUrl: string, schema: string, allow = `${ALLOWED},${SECOND}`): Promise<Harness> {
  const url = await createStageSchema(adminUrl, schema);
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const db = drizzle(pool) as unknown as PrincipalsDb;
  const mail: Mail[] = [];
  const logLines: string[] = [];
  const logger = createLogger({ write: (l) => logLines.push(l), level: "debug" });
  const allowlist = new Allowlist(() => Promise.resolve(allow), { logger });
  const cimd = new Map<string, unknown>();
  const cimdFetches: string[] = [];
  const isAllowed = (email: string) => allowlist.has(email);
  const deps = (database: AuthDeps["db"]): AuthDeps => ({
    db: database,
    config: { baseURL: BASE, issuer: ISSUER, mcpUrl: MCP, secret: SECRET },
    sendMagicLink: (email, link) => {
      mail.push({ email, url: link });
      return Promise.resolve();
    },
    isAllowed,
    logger,
    rateLimit: false,
    fetchClientMetadata: (input) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      cimdFetches.push(target);
      const doc = cimd.get(target);
      if (doc === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } }));
    },
  });
  const auth = createAuth(deps(db));
  return {
    pool,
    db,
    auth,
    authOn: (database) => createAuth(deps(database)),
    mail,
    logLines,
    logger,
    cimd,
    cimdFetches,
    isAllowed,
    close: async () => {
      await pool.end();
    },
  };
}

/** A browser: cookies kept between requests, redirects not followed. */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly auth: Auth) {}

  headers(extra: Record<string, string> = {}): Headers {
    const h = new Headers({ origin: BASE, ...extra });
    if (this.cookies.size) h.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    return h;
  }

  async request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}${pathOrUrl}`;
    const headers = this.headers();
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    const res = await this.auth.handler(new Request(url, { ...init, headers, redirect: "manual" }));
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1);
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizePath(params: Record<string, string>): string {
  return `/api/auth/oauth2/authorize?${new URLSearchParams(params).toString()}`;
}

export async function registerDynamic(auth: Auth, body: Record<string, unknown>): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function token(auth: Auth, form: Record<string, string>): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    }),
  );
}

export const metadataHandlers = (auth: Auth) => ({
  oauth: oauthProviderAuthServerMetadata(auth),
  openid: oauthProviderOpenIdConfigMetadata(auth),
});
