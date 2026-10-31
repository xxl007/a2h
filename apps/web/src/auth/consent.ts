// Consent (spec principal-identity "Consent names the client and the scopes";
// design D4, Screens S4). Better Auth sends the browser to /consent with the
// authorization request as a signed query; `readConsentRequest` turns it into
// what the screen shows, `decideConsent` records the choice.
//
// Accepting records Better Auth's consent and the authorization code AND
// creates the principal and its policy (`ensurePrincipal`, stage default) in
// one database transaction: a failure in either leaves neither (D4). The
// Better Auth instance for that call is built on the transaction.
import { ensurePrincipal, oauthClient, type PrincipalPolicy, type PrincipalsDb, eq } from "@a2h/db";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { AUTH_BASE_PATH } from "../config";
import type { Logger } from "../log";
import { SCOPES, type A2hScope, type Auth } from "./auth";

export type ClientRegistration = "metadata-document" | "dynamic" | "pre-registered";

export interface ClientSummary {
  id: string;
  name: string;
  origin: string;
  registration: ClientRegistration;
}

export type ConsentRequest =
  | {
      state: "ready";
      client: ClientSummary;
      scopes: A2hScope[];
      returnOrigin: string;
      /** The signed query, posted back with the choice; never displayed. */
      oauthQuery: string;
    }
  | { state: "invalid" }
  | { state: "expired" };

/** Marker in `oauth_client.metadata` for clients created from AUTH_CLIENTS_JSON (clients.ts). */
export const PRE_REGISTERED = "pre-registered";

/** Host shown for a URL: the hostname (no port), so loopback reads as "a program on this computer". */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function registrationOf(row: { clientId: string; clientDiscoveryId: string | null; metadata: unknown }): ClientRegistration {
  if (row.clientDiscoveryId || /^https:\/\//.test(row.clientId)) return "metadata-document";
  const meta = typeof row.metadata === "string" ? safeJson(row.metadata) : row.metadata;
  if (meta && typeof meta === "object" && (meta as Record<string, unknown>)["a2h_registration"] === PRE_REGISTERED) return "pre-registered";
  return "dynamic";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The client as the screen names it (design S4 data). */
export function summarize(
  row: { clientId: string; clientDiscoveryId: string | null; metadata: unknown; name: string | null; redirectUris: string[] },
  redirectUri?: string,
): ClientSummary | undefined {
  const registration = registrationOf(row);
  const origin = registration === "metadata-document" ? hostOf(row.clientId) : hostOf(redirectUri ?? row.redirectUris[0] ?? "");
  if (!origin) return undefined;
  return { id: row.clientId, name: row.name?.trim() || origin, origin, registration };
}

export async function readConsentRequest(
  db: PrincipalsDb,
  secret: string,
  query: URLSearchParams,
  now: () => number = Date.now,
): Promise<ConsentRequest> {
  const oauthQuery = query.toString();
  if (!(await verifyOAuthQueryParams(oauthQuery, secret))) {
    // Only which message to show depends on this unverified value; both say nothing was connected.
    const exp = Number(query.get("exp"));
    return Number.isFinite(exp) && exp > 0 && exp * 1000 < now() && query.get("sig") ? { state: "expired" } : { state: "invalid" };
  }
  const clientId = query.get("client_id");
  const redirectUri = query.get("redirect_uri");
  if (!clientId || !redirectUri) return { state: "invalid" };
  const requested = (query.get("scope") ?? "").split(" ").filter(Boolean);
  if (requested.length === 0 || !requested.every((s): s is A2hScope => (SCOPES as readonly string[]).includes(s))) return { state: "invalid" };
  const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  if (!row || row.disabled) return { state: "invalid" };
  // A native client's loopback redirect may differ by port only (Better Auth allows it).
  if (!row.redirectUris.includes(redirectUri) && !row.redirectUris.some((u) => sameLoopbackExceptPort(u, redirectUri))) return { state: "invalid" };
  const client = summarize(row, redirectUri);
  const returnOrigin = hostOf(redirectUri);
  if (!client || !returnOrigin) return { state: "invalid" };
  const scopes = SCOPES.filter((s) => requested.includes(s));
  return { state: "ready", client, scopes, returnOrigin, oauthQuery };
}

function sameLoopbackExceptPort(registered: string, used: string): boolean {
  try {
    const a = new URL(registered);
    const b = new URL(used);
    const loop = (h: string) => h === "127.0.0.1" || h === "[::1]" || h === "localhost";
    return a.protocol === "http:" && b.protocol === "http:" && loop(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/** The consent call was refused (expired or tampered request, no session): nothing was recorded. */
export class ConsentError extends Error {
  constructor(readonly status: number) {
    super(`consent refused (${status})`);
    this.name = "ConsentError";
  }
}

export interface ConsentDeps {
  db: PrincipalsDb;
  /** The issuer's origin; the consent call is made to it. */
  baseURL: string;
  /** A Better Auth instance on the given database (the transaction). */
  authOn: (db: PrincipalsDb) => Auth;
  defaultPolicy: PrincipalPolicy;
  logger: Logger;
}

export interface ConsentDecision {
  accept: boolean;
  oauthQuery: string;
  userId: string;
  headers: Headers;
  requestId?: string;
}

/** Records the choice; returns where the browser goes (the client's redirect URI with a code or `access_denied`). */
export async function decideConsent(deps: ConsentDeps, decision: ConsentDecision): Promise<string> {
  const url = await deps.db.transaction(async (tx) => {
    const auth = deps.authOn(tx);
    // Through the handler, not auth.api: the authorize step that issues the
    // code needs the request. The browser's cookie identifies the session.
    const headers = new Headers({ "content-type": "application/json", origin: deps.baseURL, accept: "application/json" });
    const cookie = decision.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
    const res = await auth.handler(
      new Request(`${deps.baseURL}${AUTH_BASE_PATH}/oauth2/consent`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accept: decision.accept, oauth_query: decision.oauthQuery }),
      }),
    );
    const result = (await res.json().catch(() => ({}))) as { redirect?: boolean; url?: string };
    if (!res.ok || !result.url) throw new ConsentError(res.status);
    if (decision.accept) await ensurePrincipal(tx, decision.userId, { policy: deps.defaultPolicy });
    return result.url;
  });
  const clientId = new URLSearchParams(decision.oauthQuery).get("client_id") ?? undefined;
  deps.logger.info(decision.accept ? "consent accepted" : "consent declined", {
    code: decision.accept ? "consent_accepted" : "consent_declined",
    principal_id: decision.userId,
    ...(clientId ? { client_id: clientId } : {}),
    ...(decision.requestId ? { request_id: decision.requestId } : {}),
  });
  return url;
}
