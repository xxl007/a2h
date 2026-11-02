// Task 10.5 (cold review of PR #51, finding B1). Spec principal-identity,
// scenario "Address removed from the allow-list": within the allow-list
// refresh interval (five minutes) a removed principal can no longer sign in,
// use an existing session, consent to a client or refresh a token; access
// tokens already issued live to their own expiry (ADR 0004 decision 2).
// The allow-list is the app's cached reader (src/auth/allowlist.ts) over a
// source the test changes, with a clock the test moves past the refresh.
import { oauthConsent, oauthRefreshToken, principals, session, user, and, eq, isNull } from "@a2h/db";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from "vitest";
import { ALLOWLIST_REFRESH_MS } from "../src/auth/allowlist";
import { ConsentError, decideConsent, readConsentRequest } from "../src/auth/consent";
import { authorizeUrlFromLoginQuery, requestMagicLink } from "../src/auth/sign-in";
import { BASE, Browser, ISSUER, MCP, POLICY, SECRET, authorizePath, pkce, registerDynamic, startHarness, token, type Harness } from "./lib/auth-harness";

const adminUrl = inject("pgAdminUrl");
const REDIRECT = "http://127.0.0.1:33419/callback";
// Synthetic addresses on a reserved domain; one per path so the tests do not share state.
const STAYS = "stays@example.com";
const SESSION = "removed-session@example.com";
const CONSENT = "removed-consent@example.com";
const REFRESH = "removed-refresh@example.com";
const LINK = "removed-link@example.com";
const CHECKED = "consent-checked@example.com";

describe.skipIf(!adminUrl)("Scenario: Address removed from the allow-list", () => {
  let h: Harness;
  let jwks: ReturnType<typeof createLocalJWKSet>;
  let listed: Set<string>;
  let clock = Date.now();
  let clientId = "";

  /** The owner removes `email`; the reader picks it up at its next refresh. */
  function removeAndWaitForRefresh(email: string): void {
    listed.delete(email);
    clock += ALLOWLIST_REFRESH_MS + 1;
  }

  beforeAll(async () => {
    listed = new Set([STAYS, SESSION, CONSENT, REFRESH, LINK, CHECKED]);
    h = await startHarness(adminUrl, "pr_105", "", {
      loadAllowlist: () => Promise.resolve([...listed].join(",")),
      now: () => clock,
    });
    const res = await h.auth.handler(new Request(`${ISSUER}/jwks`));
    jwks = createLocalJWKSet((await res.json()) as JSONWebKeySet);
    const reg = await registerDynamic(h.auth, {
      client_name: "Removal CLI",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(reg.status).toBe(201);
    clientId = ((await reg.json()) as { client_id: string }).client_id;
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => {
    // Every test starts with a fresh read of the list.
    clock += ALLOWLIST_REFRESH_MS + 1;
  });

  function authorizeParams(challenge: string): Record<string, string> {
    return {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "a2h offline_access",
      state: "st-r",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP,
    };
  }

  async function userIdOf(email: string): Promise<string> {
    const [u] = await h.db.select().from(user).where(eq(user.email, email));
    return u!.id;
  }

  /** Signs `email` in through an authorize request; returns the consent page URL. */
  async function toConsent(browser: Browser, email: string, challenge: string): Promise<URL> {
    const first = await browser.request(authorizePath(authorizeParams(challenge)));
    const login = new URL(first.headers.get("location")!, BASE);
    const next = authorizeUrlFromLoginQuery(login.searchParams);
    await requestMagicLink({ auth: h.auth, isAllowed: h.isAllowed, logger: h.logger }, { email, next, headers: new Headers({ origin: BASE }) });
    const verified = await browser.request(h.mail.at(-1)!.url);
    expect(verified.status).toBe(302);
    const again = await browser.request(verified.headers.get("location")!);
    const consent = new URL(again.headers.get("location")!, BASE);
    expect(consent.pathname).toBe("/consent");
    return consent;
  }

  /** Signs in, consents, exchanges the code: the client's tokens. */
  async function connect(email: string): Promise<{ browser: Browser; access: string; refresh: string; uid: string }> {
    const browser = new Browser(h.auth);
    const { verifier, challenge } = pkce();
    const consentUrl = await toConsent(browser, email, challenge);
    const request = await readConsentRequest(h.db, SECRET, consentUrl.searchParams);
    if (request.state !== "ready") throw new Error("consent not ready");
    const uid = await userIdOf(email);
    const to = new URL(
      await decideConsent({ db: h.db, baseURL: BASE, authOn: h.authOn, defaultPolicy: POLICY, logger: h.logger, isAllowed: h.isAllowed }, { accept: true, oauthQuery: request.oauthQuery, userId: uid, headers: browser.headers() }),
    );
    const res = await token(h.auth, { grant_type: "authorization_code", code: to.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: MCP });
    const body = (await res.json()) as Record<string, string>;
    expect(res.status, JSON.stringify(body)).toBe(200);
    return { browser, access: body["access_token"]!, refresh: body["refresh_token"]!, uid };
  }

  async function sessionOverHttp(browser: Browser): Promise<unknown> {
    const res = await browser.request("/api/auth/get-session");
    return res.json();
  }

  test("session: an existing session is signed out and revoked after the next refresh of the list, on HTTP and server-side reads", async () => {
    const { browser, uid } = await connect(SESSION);
    expect(await sessionOverHttp(browser)).toMatchObject({ user: { id: uid } });
    expect(await h.auth.api.getSession({ headers: browser.headers() })).toMatchObject({ user: { id: uid } });

    // Removed, but the reader has not refreshed yet: the five-minute window of the spec.
    listed.delete(SESSION);
    expect(await h.auth.api.getSession({ headers: browser.headers() })).toMatchObject({ user: { id: uid } });

    clock += ALLOWLIST_REFRESH_MS + 1;
    // Server-side read (pages, server actions): no session.
    expect(await h.auth.api.getSession({ headers: browser.headers() })).toBeNull();
    // Every session of the principal is revoked, not just hidden.
    expect(await h.db.select().from(session).where(eq(session.userId, uid))).toHaveLength(0);
    // HTTP read: no session, and the cookie is cleared.
    expect(await sessionOverHttp(browser)).toBeNull();
    expect([...browser.cookies.keys()].some((k) => k.includes("session_token"))).toBe(false);

    // The authorize step does not issue a code to the already-consented client: it asks for a sign-in.
    const { challenge } = pkce();
    const res = await browser.request(authorizePath(authorizeParams(challenge)));
    const to = new URL(res.headers.get("location")!, BASE);
    expect(to.pathname).toBe("/sign-in");
    expect(to.searchParams.get("code")).toBeNull();
  });

  test("session: a listed principal's session is untouched by the check", async () => {
    const { browser, uid } = await connect(STAYS);
    expect(await sessionOverHttp(browser)).toMatchObject({ user: { id: uid } });
    clock += ALLOWLIST_REFRESH_MS + 1;
    expect(await h.auth.api.getSession({ headers: browser.headers() })).toMatchObject({ user: { id: uid } });
    expect(await h.db.select().from(session).where(eq(session.userId, uid))).not.toHaveLength(0);
  });

  test("consent: refused, with no consent, code or principal recorded", async () => {
    const browser = new Browser(h.auth);
    const { challenge } = pkce();
    const consentUrl = await toConsent(browser, CONSENT, challenge);
    const request = await readConsentRequest(h.db, SECRET, consentUrl.searchParams);
    if (request.state !== "ready") throw new Error("consent not ready");
    const uid = await userIdOf(CONSENT);

    removeAndWaitForRefresh(CONSENT);
    const decided = decideConsent(
      { db: h.db, baseURL: BASE, authOn: h.authOn, defaultPolicy: POLICY, logger: h.logger, isAllowed: h.isAllowed },
      { accept: true, oauthQuery: request.oauthQuery, userId: uid, headers: browser.headers() },
    );
    await expect(decided).rejects.toBeInstanceOf(ConsentError);
    expect(await h.db.select().from(oauthConsent).where(eq(oauthConsent.userId, uid))).toHaveLength(0);
    expect(await h.db.select().from(principals).where(eq(principals.principal_id, uid))).toHaveLength(0);
  });

  test("consent: the consent step re-checks the list itself, not trusting its caller's session check", async () => {
    // The session is valid (address listed for the session hook), but the consent step's own reader says no:
    // nothing is recorded. Guards against a future caller that reaches decideConsent without a session read.
    const browser = new Browser(h.auth);
    const { challenge } = pkce();
    const consentUrl = await toConsent(browser, CHECKED, challenge);
    const request = await readConsentRequest(h.db, SECRET, consentUrl.searchParams);
    if (request.state !== "ready") throw new Error("consent not ready");
    const uid = await userIdOf(CHECKED);
    const consentsBefore = (await h.db.select().from(oauthConsent).where(eq(oauthConsent.userId, uid))).length;
    await expect(
      decideConsent(
        { db: h.db, baseURL: BASE, authOn: h.authOn, defaultPolicy: POLICY, logger: h.logger, isAllowed: () => Promise.resolve(false) },
        { accept: true, oauthQuery: request.oauthQuery, userId: uid, headers: browser.headers() },
      ),
    ).rejects.toBeInstanceOf(ConsentError);
    expect(await h.db.select().from(oauthConsent).where(eq(oauthConsent.userId, uid))).toHaveLength(consentsBefore);
  });

  test("refresh: the refresh grant is refused and the family revoked; an access token already issued still verifies until its expiry", async () => {
    const { access, refresh, uid } = await connect(REFRESH);
    // Rotation works while listed.
    const r1 = await token(h.auth, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: MCP });
    const b1 = (await r1.json()) as Record<string, string>;
    expect(r1.status, JSON.stringify(b1)).toBe(200);
    const rotated = b1["refresh_token"]!;

    removeAndWaitForRefresh(REFRESH);
    const refused = await token(h.auth, { grant_type: "refresh_token", refresh_token: rotated, client_id: clientId, resource: MCP });
    const body = (await refused.json()) as Record<string, unknown>;
    expect(refused.status).toBe(400);
    expect(body["error"]).toBe("invalid_grant");
    expect(body["access_token"]).toBeUndefined();
    // No live refresh token is left for the principal.
    const live = await h.db.select().from(oauthRefreshToken).where(and(eq(oauthRefreshToken.userId, uid), isNull(oauthRefreshToken.revoked)));
    expect(live).toHaveLength(0);

    // Put back on the list: the revoked family stays dead (a new consent flow is needed).
    listed.add(REFRESH);
    clock += ALLOWLIST_REFRESH_MS + 1;
    const after = await token(h.auth, { grant_type: "refresh_token", refresh_token: rotated, client_id: clientId, resource: MCP });
    expect(after.status).toBe(400);

    // ADR 0004 decision 4: access tokens are not individually revocable; the one issued before removal verifies until exp.
    const { payload } = await jwtVerify(access, jwks, { issuer: ISSUER, audience: MCP });
    expect(payload.sub).toBe(uid);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(3600);
  });

  test("sign-in: a magic link sent while listed signs nobody in once the address is removed", async () => {
    const browser = new Browser(h.auth);
    await requestMagicLink({ auth: h.auth, isAllowed: h.isAllowed, logger: h.logger }, { email: LINK, next: undefined, headers: new Headers({ origin: BASE }) });
    const link = h.mail.at(-1)!;
    expect(link.email).toBe(LINK);
    removeAndWaitForRefresh(LINK);
    await browser.request(link.url);
    expect(await sessionOverHttp(browser)).toBeNull();
  });

  test("no log line carries an address", () => {
    expect(h.logLines.join("\n")).not.toMatch(/@/);
  });
});
