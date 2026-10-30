// Tasks 5.2, 5.4, 5.5, 5.6 in-process: an MCP client registers, its user signs
// in by magic link, consents, and the client gets audience-bound tokens.
// Spec principal-identity: "Consent accepted", "Consent declined", "Client
// revoked", "Clients register by…" (dynamic, PKCE missing, metadata-document,
// private address), "Resource recorded as audience", "Refresh token
// replayed"; design D4 (consent and principal rows in one transaction).
import { oauthClient, oauthConsent, oauthRefreshToken, principalPolicies, principals, user, verification, eq } from "@a2h/db";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet } from "jose";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { listConnectedClients, revokeClient } from "../src/auth/account";
import { decideConsent, readConsentRequest } from "../src/auth/consent";
import { authorizeUrlFromLoginQuery, requestMagicLink } from "../src/auth/sign-in";
import {
  ALLOWED,
  BASE,
  Browser,
  ISSUER,
  MCP,
  POLICY,
  SECOND,
  SECRET,
  authorizePath,
  pkce,
  registerDynamic,
  startHarness,
  token,
  type Harness,
} from "./lib/auth-harness";

const adminUrl = inject("pgAdminUrl");
const REDIRECT = "http://127.0.0.1:33418/callback";

describe.skipIf(!adminUrl)("OAuth 2.1 flow of an MCP client", () => {
  let h: Harness;
  let jwks: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    h = await startHarness(adminUrl, "pr_55");
    const res = await h.auth.handler(new Request(`${ISSUER}/jwks`));
    jwks = createLocalJWKSet((await res.json()) as JSONWebKeySet);
  });
  afterAll(async () => {
    await h?.close();
  });

  const consentDeps = () => ({ db: h.db, baseURL: BASE, authOn: h.authOn, defaultPolicy: POLICY, logger: h.logger });

  async function register(extra: Record<string, unknown> = {}): Promise<string> {
    const res = await registerDynamic(h.auth, {
      client_name: "Test CLI",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...extra,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }

  /** Signs `email` in through the login redirect of an authorize request; returns the URL the authorize step then sends the browser to. */
  async function signInThroughAuthorizeTo(browser: Browser, authorize: string, email = ALLOWED): Promise<URL> {
    const first = await browser.request(authorize);
    expect(first.status).toBe(302);
    const login = new URL(first.headers.get("location")!, BASE);
    expect(login.pathname).toBe("/sign-in");
    const next = authorizeUrlFromLoginQuery(login.searchParams);
    expect(next).toBeDefined();
    await requestMagicLink({ auth: h.auth, isAllowed: h.isAllowed, logger: h.logger }, { email, next, headers: new Headers({ origin: BASE }) });
    const link = h.mail.at(-1)!.url;
    const verified = await browser.request(link);
    expect(verified.status).toBe(302);
    const back = verified.headers.get("location")!;
    expect(back.startsWith(`${BASE}/api/auth/oauth2/authorize?`)).toBe(true);
    const again = await browser.request(back);
    expect(again.status).toBe(302);
    return new URL(again.headers.get("location")!, BASE);
  }

  /** As above, for a client without a consent yet: the consent page. */
  async function signInThroughAuthorize(browser: Browser, authorize: string, email = ALLOWED): Promise<URL> {
    const consent = await signInThroughAuthorizeTo(browser, authorize, email);
    expect(consent.pathname).toBe("/consent");
    return consent;
  }

  function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
    return {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "a2h offline_access",
      state: "st-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP,
      ...extra,
    };
  }

  async function userIdOf(email: string): Promise<string> {
    const [u] = await h.db.select().from(user).where(eq(user.email, email));
    return u!.id;
  }

  let clientId = "";
  let refresh = "";
  let firstAccess = "";

  test("Scenario: Dynamic registration: a client_id, marked dynamic (no metadata document, not pre-registered)", async () => {
    clientId = await register({ application_type: "native" });
    const [row] = await h.db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
    expect(row!.clientDiscoveryId).toBeNull();
    expect(row!.clientSecret).toBeNull();
    expect(row!.tokenEndpointAuthMethod).toBe("none");
  });

  test("dynamic registration without application_type and a loopback redirect: native by default", async () => {
    const id = await register({ client_name: "No type" });
    const [row] = await h.db.select().from(oauthClient).where(eq(oauthClient.clientId, id));
    expect(row!.applicationType).toBe("native");
  });

  test("Scenario: PKCE missing (or plain): invalid_request before any consent screen", async () => {
    const b = new Browser(h.auth);
    const { challenge } = pkce();
    for (const params of [
      (() => {
        const p: Record<string, string> = authorizeParams(clientId, challenge);
        delete p["code_challenge"];
        delete p["code_challenge_method"];
        return p;
      })(),
      authorizeParams(clientId, challenge, { code_challenge_method: "plain" }),
    ]) {
      const res = await b.request(authorizePath(params));
      const location = res.headers.get("location") ?? "";
      expect(location).not.toContain("/consent");
      expect(location).not.toContain("/sign-in");
      const to = new URL(location, BASE);
      expect(to.searchParams.get("error")).toBe("invalid_request");
    }
  });

  test("Scenario: Consent accepted: code bound to PKCE, redirect URI and resource; consent and principal recorded together", async () => {
    const browser = new Browser(h.auth);
    const { verifier, challenge } = pkce();
    const consentUrl = await signInThroughAuthorize(browser, authorizePath(authorizeParams(clientId, challenge)));

    const request = await readConsentRequest(h.db, SECRET, consentUrl.searchParams);
    expect(request).toMatchObject({
      state: "ready",
      client: { id: clientId, name: "Test CLI", origin: "127.0.0.1", registration: "dynamic" },
      scopes: ["a2h", "offline_access"],
      returnOrigin: "127.0.0.1",
    });
    if (request.state !== "ready") throw new Error("not ready");

    const uid = await userIdOf(ALLOWED);
    expect(await h.db.select().from(principals).where(eq(principals.principal_id, uid))).toHaveLength(0);
    const to = await decideConsent(consentDeps(), { accept: true, oauthQuery: request.oauthQuery, userId: uid, headers: browser.headers() });
    const back = new URL(to);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
    const code = back.searchParams.get("code")!;
    expect(code).toBeTruthy();

    expect(await h.db.select().from(oauthConsent).where(eq(oauthConsent.userId, uid))).toHaveLength(1);
    expect(await h.db.select().from(principals).where(eq(principals.principal_id, uid))).toHaveLength(1);
    const [policy] = await h.db.select().from(principalPolicies).where(eq(principalPolicies.principal_id, uid));
    expect(policy).toMatchObject({ currency: "EUR", monthly_budget_minor: 50_000, ask_first_above_minor: null });

    const res = await token(h.auth, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: MCP });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body["token_type"]).toMatch(/bearer/i);
    expect(body["expires_in"]).toBeLessThanOrEqual(3600);
    firstAccess = body["access_token"] as string;
    refresh = body["refresh_token"] as string;
    expect(refresh).toBeTruthy();

    // Scenario: Resource recorded as audience.
    const { payload, protectedHeader } = await jwtVerify(firstAccess, jwks, { issuer: ISSUER, audience: MCP });
    expect(protectedHeader.alg).toBe("EdDSA");
    expect(payload.aud === MCP || (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === MCP)).toBe(true);
    expect(payload.sub).toBe(uid);
    expect(String(payload["scope"]).split(" ").sort()).toEqual(["a2h", "offline_access"]);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(3600);
    expect(payload["azp"] ?? payload["client_id"]).toBe(clientId);

    // Tokens at rest are hashed (design D10).
    const stored = await h.db.select().from(oauthRefreshToken);
    expect(stored.some((r) => r.token === refresh)).toBe(false);
  });

  test("Scenario: Refresh token replayed: refused, and the family is revoked", async () => {
    expect(refresh).toBeTruthy();
    const r1 = await token(h.auth, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: MCP });
    const b1 = (await r1.json()) as Record<string, string>;
    expect(r1.status, JSON.stringify(b1)).toBe(200);
    const rotated = b1["refresh_token"]!;
    expect(rotated).not.toBe(refresh);
    const { payload } = await jwtVerify(b1["access_token"]!, jwks, { issuer: ISSUER, audience: MCP });
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(3600);

    const replay = await token(h.auth, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: MCP });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as Record<string, string>)["error"]).toBe("invalid_grant");

    // The descendant issued before the replay is dead too.
    const child = await token(h.auth, { grant_type: "refresh_token", refresh_token: rotated, client_id: clientId, resource: MCP });
    expect(child.status).toBe(400);
  });

  test("a token for another resource is not issued", async () => {
    const browser = new Browser(h.auth);
    const { challenge } = pkce();
    const res = await browser.request(authorizePath(authorizeParams(clientId, challenge, { resource: "https://mcp.dev.a2h-protocol.org/pr-9/mcp" })));
    const location = new URL(res.headers.get("location") ?? "", BASE);
    expect(location.pathname).not.toBe("/consent");
    expect(location.searchParams.get("error")).toBeTruthy();
  });

  test("Scenario: Consent declined: access_denied, no code, no consent, no principal", async () => {
    const id = await register({ client_name: "Declined app" });
    const browser = new Browser(h.auth);
    const { challenge } = pkce();
    const consentUrl = await signInThroughAuthorize(browser, authorizePath(authorizeParams(id, challenge)), SECOND);
    const request = await readConsentRequest(h.db, SECRET, consentUrl.searchParams);
    if (request.state !== "ready") throw new Error("not ready");
    const uid = await userIdOf(SECOND);
    const codesBefore = (await h.db.select().from(verification)).length;
    const to = new URL(await decideConsent(consentDeps(), { accept: false, oauthQuery: request.oauthQuery, userId: uid, headers: browser.headers() }));
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("code")).toBeNull();
    expect(to.searchParams.get("state")).toBe("st-1");
    expect(await h.db.select().from(oauthConsent).where(eq(oauthConsent.userId, uid))).toHaveLength(0);
    expect(await h.db.select().from(principals).where(eq(principals.principal_id, uid))).toHaveLength(0);
    expect((await h.db.select().from(verification)).length).toBe(codesBefore);
  });

  test("D4: a failure while creating the principal rolls the consent and the code back", async () => {
    const id = await register({ client_name: "Rollback app" });
    const browser = new Browser(h.auth);
    const { challenge } = pkce();
    const consentUrl = await signInThroughAuthorize(browser, authorizePath(authorizeParams(id, challenge)), SECOND);
    const request = await readConsentRequest(h.db, SECRET, consentUrl.searchParams);
    if (request.state !== "ready") throw new Error("not ready");
    const uid = await userIdOf(SECOND);
    const codesBefore = (await h.db.select().from(verification)).length;
    const broken = { ...consentDeps(), defaultPolicy: { ...POLICY, currency: "euro" } };
    await expect(decideConsent(broken, { accept: true, oauthQuery: request.oauthQuery, userId: uid, headers: browser.headers() })).rejects.toThrow();
    expect(await h.db.select().from(oauthConsent).where(eq(oauthConsent.clientId, id))).toHaveLength(0);
    expect(await h.db.select().from(principals).where(eq(principals.principal_id, uid))).toHaveLength(0);
    expect((await h.db.select().from(verification)).length).toBe(codesBefore);

    // ...and a refused consent call leaves no principal either.
    await expect(decideConsent(consentDeps(), { accept: true, oauthQuery: `${request.oauthQuery}x`, userId: uid, headers: browser.headers() })).rejects.toThrow();
    expect(await h.db.select().from(principals).where(eq(principals.principal_id, uid))).toHaveLength(0);
  });

  test("consent page: a tampered query is invalid, an old one expired", async () => {
    const q = new URLSearchParams({ client_id: clientId, scope: "a2h", redirect_uri: REDIRECT, exp: String(Math.floor(Date.now() / 1000) - 10), sig: "x" });
    expect(await readConsentRequest(h.db, SECRET, q)).toEqual({ state: "expired" });
    q.set("exp", String(Math.floor(Date.now() / 1000) + 600));
    expect(await readConsentRequest(h.db, SECRET, q)).toEqual({ state: "invalid" });
    expect(await readConsentRequest(h.db, SECRET, new URLSearchParams())).toEqual({ state: "invalid" });
  });

  test("Scenario: Client revoked: listed, then revoked; its refresh tokens fail from then on", async () => {
    const browser = new Browser(h.auth);
    const { verifier, challenge } = pkce();
    // The principal consented to this client before: authorize returns the code without asking again.
    const back = await signInThroughAuthorizeTo(browser, authorizePath(authorizeParams(clientId, challenge)));
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    const uid = await userIdOf(ALLOWED);
    const code = back.searchParams.get("code")!;
    // The code is bound to the PKCE verifier: a wrong one is refused, and the code is spent.
    const wrong = await token(h.auth, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: pkce().verifier, resource: MCP });
    expect(wrong.status).toBe(400);
    const spent = await token(h.auth, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: MCP });
    expect(spent.status).toBe(400);
    const { verifier: v2, challenge: c2 } = pkce();
    const again = async (challenge: string) => new URL((await browser.request(authorizePath(authorizeParams(clientId, challenge)))).headers.get("location")!, BASE);
    const code2 = (await again(c2)).searchParams.get("code")!;
    // Bound to the redirect URI too.
    const otherRedirect = await token(h.auth, { grant_type: "authorization_code", code: code2, redirect_uri: "http://127.0.0.1:9/other", client_id: clientId, code_verifier: v2, resource: MCP });
    expect(otherRedirect.status).toBe(400);
    const { verifier: v3, challenge: c3 } = pkce();
    const code3 = (await again(c3)).searchParams.get("code")!;
    void verifier;
    const res = await token(h.auth, { grant_type: "authorization_code", code: code3, redirect_uri: REDIRECT, client_id: clientId, code_verifier: v3, resource: MCP });
    const fresh = ((await res.json()) as Record<string, string>)["refresh_token"]!;

    const listed = await listConnectedClients(h.db, uid);
    expect(listed.map((c) => [c.id, c.name, c.registration])).toEqual([[clientId, "Test CLI", "dynamic"]]);
    expect(listed[0]!.connectedAt).toBeInstanceOf(Date);
    // Another principal's list does not show it.
    expect((await listConnectedClients(h.db, await userIdOf(SECOND))).map((c) => c.id)).not.toContain(clientId);

    expect(await revokeClient(h.db, h.logger, uid, clientId)).toBe(true);
    expect(await listConnectedClients(h.db, uid)).toEqual([]);
    const after = await token(h.auth, { grant_type: "refresh_token", refresh_token: fresh, client_id: clientId, resource: MCP });
    expect(after.status).toBe(400);
    // Requests and the principal are not touched by a revoke.
    expect(await h.db.select().from(principals).where(eq(principals.principal_id, uid))).toHaveLength(1);
    // The access token issued earlier is still a valid JWT until its own expiry (D1: not individually revocable).
    expect(decodeJwt(firstAccess).sub).toBe(uid);
  });

  test("no log line of the flow carries an address or a token", () => {
    const all = h.logLines.join("\n");
    expect(all).not.toMatch(/@/);
    expect(refresh).toBeTruthy();
    expect(all).not.toContain(refresh);
    expect(all).not.toContain(firstAccess.slice(0, 30));
  });
});
