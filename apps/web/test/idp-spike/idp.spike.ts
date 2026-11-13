// SPIKE (m2-org-sign-in task 2.1, issue #127): the eight points of the brief,
// each run against a real Keycloak (pinned image, imported realm) and a real
// Postgres with the repo's migrations. The web app's authorization server is
// in-process and driven over its HTTP handler, as apps/web's own tests do
// (test/lib/auth-harness.ts). Lines starting with EVIDENCE are the recorded
// output quoted in notes/spike.md. No address of a real person; no secret or
// token value is printed (presence and length only).
import { appendFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, test, vi } from "vitest";
import type { PrincipalsDb } from "@a2h/db";
import { decideConsent, readConsentRequest } from "../../src/auth/consent";
import { authorizeUrlFromLoginQuery } from "../../src/auth/sign-in";
import type { Auth } from "../../src/auth/auth";
import { createLogger } from "../../src/log";
import { BASE, Browser, MCP, POLICY, SECRET, authorizePath, pkce, registerDynamic, token } from "../lib/auth-harness";
import { createStageSchema } from "../lib/postgres";
import { CLIENT_ID, CLIENT_SECRET, ProviderBrowser, USERS, startKeycloak, type Keycloak, type TestUser } from "./keycloak/keycloak";
import { createSpikeAuth, SESSION_SECONDS, type SpikeEvent, type SpikeOptions } from "./spike-auth";

const adminUrl = inject("pgAdminUrl");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function evidence(point: string, data: unknown): void {
  const line = `EVIDENCE ${point} ${JSON.stringify(data)}`;
  console.log(line);
  const file = process.env["A2H_SPIKE_EVIDENCE"];
  if (file) appendFileSync(file, `${line}\n`);
}

interface World {
  pool: pg.Pool;
  db: PrincipalsDb;
  auth: Auth;
  events: SpikeEvent[];
  logLines: string[];
  options: SpikeOptions;
  q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  counts: () => Promise<{ users: number; accounts: number; sessions: number }>;
}

type Toggles = Partial<Pick<SpikeOptions, "validate" | "stripTokens" | "disableImplicitLinking" | "disableSocialPath" | "session" | "lastSignInWriter" | "renewalWindow" | "emailVerifiedClaim">>;

describe.skipIf(!adminUrl)("spike: sign-in through Keycloak with genericOAuth, provider id idp", () => {
  let kc: Keycloak;
  const worlds: World[] = [];

  beforeAll(() => {
    kc = startKeycloak();
  });
  afterAll(async () => {
    for (const w of worlds) await w.pool.end();
    kc?.stop();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function world(schema: string, toggles: Toggles = {}): Promise<World> {
    const url = await createStageSchema(adminUrl, schema);
    const pool = new pg.Pool({ connectionString: url, max: 6 });
    // The column of D6/D7; the real migration is task 3.2 (Protocol dev).
    await pool.query(`alter table "user" add column last_idp_sign_in_at timestamp`);
    const db = drizzle(pool) as unknown as PrincipalsDb;
    const events: SpikeEvent[] = [];
    const logLines: string[] = [];
    const options: SpikeOptions = {
      db,
      sql: (text, params) => pool.query(text, params as unknown[]),
      baseURL: BASE,
      mcpUrl: MCP,
      secret: SECRET,
      idp: { discoveryUrl: kc.discoveryUrl, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      validate: true,
      stripTokens: true,
      disableImplicitLinking: true,
      disableSocialPath: true,
      session: "global",
      lastSignInWriter: "after-hook",
      events,
      logLines,
      ...toggles,
    };
    const q = async (text: string, params?: unknown[]) => (await pool.query(text, params as unknown[])).rows as Record<string, unknown>[];
    const w: World = {
      pool,
      db,
      auth: createSpikeAuth(options),
      events,
      logLines,
      options,
      q,
      counts: async () => {
        const [r] = await q(`select (select count(*)::int from "user") users, (select count(*)::int from account) accounts, (select count(*)::int from session) sessions`);
        return r as { users: number; accounts: number; sessions: number };
      },
    };
    worlds.push(w);
    return w;
  }

  /** What the sign-in server action does: no HTTP call to /sign-in/social; the state cookie goes to the browser. */
  async function startFromServerAction(w: World, browser: Browser, callbackURL = "/account/clients"): Promise<string> {
    const result = (await w.auth.api.signInSocial({
      body: { provider: "idp", callbackURL, errorCallbackURL: "/sign-in" },
      headers: browser.headers(),
      returnHeaders: true,
    } as never)) as unknown as { headers: Headers; response: { url: string; redirect: boolean } };
    for (const line of result.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      browser.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1));
    }
    return result.response.url;
  }

  /** Full round trip; returns the app's answer to the callback. */
  async function signIn(w: World, browser: Browser, user: TestUser | undefined, provider = new ProviderBrowser(), callbackURL?: string) {
    const authorizeUrl = await startFromServerAction(w, browser, callbackURL);
    const { location, formShown } = await provider.signIn(authorizeUrl, user);
    const res = await browser.request(location);
    return { authorizeUrl: new URL(authorizeUrl), callback: new URL(location), res, to: res.headers.get("location") ?? "", formShown };
  }

  async function getSession(w: World, browser: Browser): Promise<{ session: { expiresAt: string }; user: { id: string } } | null> {
    const res = await browser.request("/api/auth/get-session");
    return (await res.json()) as never;
  }

  test("1. callback path /api/auth/callback/idp; a full sign-in creates user, account (subject stored) and session", async () => {
    const w = await world("spike_p1");
    const browser = new Browser(w.auth);
    const before = await w.counts();
    const r = await signIn(w, browser, USERS.verified);

    expect(r.authorizeUrl.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/idp`);
    expect(`${r.callback.origin}${r.callback.pathname}`).toBe(`${BASE}/api/auth/callback/idp`);
    expect(r.res.status).toBe(302);
    expect(r.to).toBe("/account/clients");
    const after = await w.counts();
    expect(after).toEqual({ users: 1, accounts: 1, sessions: 1 });
    const [acct] = await w.q(`select provider_id, account_id, user_id from account`);
    const [usr] = await w.q(`select id, email, email_verified, name from "user"`);
    expect(acct!["provider_id"]).toBe("idp");
    expect(acct!["account_id"]).toMatch(/^[0-9a-f-]{36}$/); // Keycloak's subject is the user's UUID
    expect(usr!["email"]).toBe(USERS.verified.email);
    expect(usr!["email_verified"]).toBe(true);
    const s = await getSession(w, browser);
    expect(s?.user.id).toBe(usr!["id"]);

    // Keycloak refuses any other redirect address for this client.
    const other = new URL(r.authorizeUrl);
    other.searchParams.set("redirect_uri", `${BASE}/api/auth/oauth2/callback/idp`);
    const refused = await fetch(other, { redirect: "manual" });
    evidence("1", {
      authorize: {
        redirect_uri: r.authorizeUrl.searchParams.get("redirect_uri"),
        response_type: r.authorizeUrl.searchParams.get("response_type"),
        scope: r.authorizeUrl.searchParams.get("scope"),
        code_challenge_method: r.authorizeUrl.searchParams.get("code_challenge_method"),
        has_state: r.authorizeUrl.searchParams.has("state"),
        has_nonce: r.authorizeUrl.searchParams.has("nonce"),
      },
      callback: { path: r.callback.pathname, params: [...r.callback.searchParams.keys()].sort() },
      appAnswer: { status: r.res.status, location: r.to },
      rowsBefore: before,
      rowsAfter: after,
      account: { provider_id: acct!["provider_id"], account_id_is_uuid: /^[0-9a-f-]{36}$/.test(String(acct!["account_id"])) },
      user: { email: usr!["email"], email_verified: usr!["email_verified"], name: usr!["name"] },
      getSessionUserMatches: s?.user.id === usr!["id"],
      keycloakOnOtherRedirectUri: refused.status,
    });
    expect(refused.status).toBe(400);

    // The same callback URL a second time (state consumed).
    const replay = await browser.request(r.callback.toString());
    evidence("1-replay", { status: replay.status, location: replay.headers.get("location"), rows: await w.counts() });
    expect(new URL(replay.headers.get("location")!, BASE).searchParams.get("error")).toBeTruthy();
    expect(await w.counts()).toEqual(after);
  });

  test("2. a refusal from validateUserInfo writes no user, account or session and carries its own error code", async () => {
    const w = await world("spike_p2");
    const b1 = new Browser(w.auth);
    const unverified = await signIn(w, b1, USERS.unverified);
    const afterUnverified = await w.counts();
    const b2 = new Browser(w.auth);
    const noemail = await signIn(w, b2, USERS.noemail);
    const afterNoEmail = await w.counts();
    evidence("2", {
      unverified: { status: unverified.res.status, location: unverified.to, rows: afterUnverified, sessionCookie: [...b1.cookies.keys()].some((k) => k.includes("session_token")), getSession: await getSession(w, b1) },
      noemail: { status: noemail.res.status, location: noemail.to, rows: afterNoEmail, getSession: await getSession(w, b2) },
      validateUserInfoCalls: w.events.filter((e) => e.hook === "validateUserInfo"),
      verificationRowsLeft: (await w.q(`select count(*)::int n from verification`))[0]!["n"],
    });
    expect(new URL(unverified.to, BASE).pathname).toBe("/sign-in");
    expect(new URL(unverified.to, BASE).searchParams.get("error")).toBe("email_not_verified");
    expect(afterUnverified).toEqual({ users: 0, accounts: 0, sessions: 0 });
    expect(new URL(noemail.to, BASE).searchParams.get("error")).toBe("email_not_found");
    expect(afterNoEmail).toEqual({ users: 0, accounts: 0, sessions: 0 });

    // Control: without validateUserInfo the unverified person gets a user, an account and a session.
    const c = await world("spike_p2_control", { validate: false });
    const cb = new Browser(c.auth);
    const let_in = await signIn(c, cb, USERS.unverified);
    evidence("2-control-no-validateUserInfo", { location: let_in.to, rows: await c.counts() });
    expect(await c.counts()).toEqual({ users: 1, accounts: 1, sessions: 1 });

    // A returning person whose provider stops asserting the address: refused at sign-in too.
    const r = await world("spike_p2_returning");
    const rb = new Browser(r.auth);
    await signIn(r, rb, USERS.verified);
    const [u] = await r.q(`select id from "user"`);
    r.options.emailVerifiedClaim = "claim_the_provider_does_not_send";
    const r2 = createSpikeAuth(r.options);
    const rb2 = new Browser(r2);
    const again = await signIn({ ...r, auth: r2 }, rb2, USERS.verified);
    evidence("2-returning-refused", {
      location: again.to,
      rows: await r.counts(),
      actions: r.events.filter((e) => e.hook === "validateUserInfo").map((e) => e["action"]),
      sessionsOfUser: (await r.q(`select count(*)::int n from session where user_id = $1`, [u!["id"]]))[0]!["n"],
    });
    expect(new URL(again.to, BASE).searchParams.get("error")).toBe("email_not_verified");
    expect((await r.counts()).sessions).toBe(1); // only the first sign-in's
  });

  test("3. provider tokens are kept out of the account row by a database hook (first and returning sign-in)", async () => {
    const tokenColumns = `select (access_token is not null) access_token, (refresh_token is not null) refresh_token, (id_token is not null) id_token, (access_token_expires_at is not null) access_token_expires_at, (refresh_token_expires_at is not null) refresh_token_expires_at, scope from account`;
    const c = await world("spike_p3_control", { stripTokens: false });
    await signIn(c, new Browser(c.auth), USERS.verified);
    const control = (await c.q(tokenColumns))[0]!;

    const w = await world("spike_p3");
    await signIn(w, new Browser(w.auth), USERS.verified);
    const first = (await w.q(tokenColumns))[0]!;
    await signIn(w, new Browser(w.auth), USERS.verified);
    const returning = (await w.q(tokenColumns))[0]!;
    evidence("3", {
      controlWithoutHook: control,
      withHook_firstSignIn: first,
      withHook_returningSignIn: returning,
      hookSaw: w.events.filter((e) => e.hook.startsWith("account.")),
      accounts: (await w.counts()).accounts,
    });
    expect(control["id_token"]).toBe(true);
    expect(control["access_token"]).toBe(true);
    for (const row of [first, returning]) {
      expect(row["access_token"]).toBe(false);
      expect(row["refresh_token"]).toBe(false);
      expect(row["id_token"]).toBe(false);
      expect(row["access_token_expires_at"]).toBe(false);
      expect(row["refresh_token_expires_at"]).toBe(false);
    }
    expect(w.events.some((e) => e.hook === "account.update.before")).toBe(true);
  });

  test("4. which hook can write last_idp_sign_in_at on every successful callback", async () => {
    for (const writer of ["after-hook", "session-db-hook"] as const) {
      const w = await world(`spike_p4_${writer === "after-hook" ? "after" : "dbhook"}`, { lastSignInWriter: writer });
      const read = async () => (await w.q(`select last_idp_sign_in_at from "user"`))[0]?.["last_idp_sign_in_at"] as Date | null | undefined;
      // Real clock here: the provider's ID token carries real iat/exp, so the callback cannot be run on a moved clock.
      const s1 = await signIn(w, new Browser(w.auth), USERS.verified);
      const first = await read();
      await new Promise((r) => setTimeout(r, 1100));
      const s2 = await signIn(w, new Browser(w.auth), USERS.verified);
      const returning = await read();
      // A refused callback (another person) and a session read must not write.
      const s3 = await signIn(w, new Browser(w.auth), USERS.unverified);
      const afterRefusal = await read();
      const result = {
        first: { to: s1.to, written: Boolean(first) },
        returning: { to: s2.to, laterThanFirstByMs: returning && first ? returning.getTime() - first.getTime() : null },
        refusedCallbackOfAnotherPerson: { to: s3.to, unchanged: afterRefusal?.getTime() === returning?.getTime() },
        hookEvents: w.events.filter((e) => e.hook === "after:/callback/:id" || e.hook === "session.create.after").map((e) => ({ ...e, userId: e["userId"] ? "<user id>" : undefined, newSessionUserId: e["newSessionUserId"] ? "<user id>" : null })),
      };
      evidence(`4-${writer}`, result);
      expect(first).toBeInstanceOf(Date);
      expect(Math.abs(first!.getTime() - Date.now())).toBeLessThan(60_000);
      expect(returning!.getTime() - first!.getTime()).toBeGreaterThanOrEqual(1000);
      expect(afterRefusal!.getTime()).toBe(returning!.getTime());
    }
  });

  test("5. /sign-in/social over HTTP is refused while the server-side call still starts the redirect", async () => {
    const w = await world("spike_p5");
    const browser = new Browser(w.auth);
    const post = (auth: Auth, body: unknown) =>
      auth.handler(new Request(`${BASE}/api/auth/sign-in/social`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) }));
    const redirectBranch = await post(w.auth, { provider: "idp", callbackURL: "/account/clients" });
    const idTokenBranch = await post(w.auth, { provider: "idp", idToken: { token: "x.y.z" } });
    const url = new URL(await startFromServerAction(w, browser));

    const c = await world("spike_p5_control", { disableSocialPath: false });
    const open = await post(c.auth, { provider: "idp", callbackURL: "/account/clients" });
    const openBody = (await open.json()) as { url?: string };
    const openIdToken = await post(c.auth, { provider: "idp", idToken: { token: "x.y.z" } });
    evidence("5", {
      disabled: { redirectBranch: redirectBranch.status, idTokenBranch: idTokenBranch.status, body: await redirectBranch.text() },
      serverAction: { host: url.host === new URL(kc.url).host, path: url.pathname, stateCookieSet: [...browser.cookies.keys()] },
      controlPathOpen: { redirectBranch: open.status, returnsAuthorizeUrl: Boolean(openBody.url?.includes("/protocol/openid-connect/auth")), idTokenBranch: openIdToken.status, idTokenBranchBody: (await openIdToken.text()).slice(0, 160) },
      rows: await w.counts(),
    });
    expect(redirectBranch.status).toBe(404);
    expect(idTokenBranch.status).toBe(404);
    expect(url.pathname).toBe("/realms/a2h-test/protocol/openid-connect/auth");
    expect(open.status).toBe(200);
    // And the action's redirect completes a sign-in.
    const r = await signIn(w, new Browser(w.auth), USERS.verified);
    expect(r.to).toBe("/account/clients");
  });

  test("6. a session ends 12 hours after sign-in, with no sliding renewal", async () => {
    const out: Record<string, unknown> = {};
    for (const mode of ["global", "hook-norefresh", "hook", "sliding-control"] as const) {
      const w = await world(`spike_p6_${mode.replace("-", "_")}`, { session: mode });
      const browser = new Browser(w.auth);
      const t0 = Math.floor(Date.now() / 1000) * 1000;
      vi.useFakeTimers({ toFake: ["Date"], now: t0 });
      await signIn(w, browser, USERS.verified);
      const stored = async () => ((await w.q(`select expires_at from session`))[0]?.["expires_at"] as Date | undefined)?.toISOString();
      const atCreation = await stored();
      const reads: Record<string, unknown> = {};
      for (const [label, offset] of [["+6h", 6 * HOUR], ["+11h59m", 12 * HOUR - 60_000], ["+12h01m", 12 * HOUR + 60_000]] as const) {
        vi.setSystemTime(t0 + offset);
        const s = await getSession(w, browser);
        reads[label] = { signedIn: Boolean(s), storedExpiry: await stored() };
      }
      vi.useRealTimers();
      out[mode] = { atCreation, reads };
      evidence(`6-${mode}`, out[mode]);
      expect(atCreation).toBe(new Date(t0 + SESSION_SECONDS * 1000).toISOString());
      const r = reads as Record<string, { signedIn: boolean; storedExpiry?: string }>;
      if (mode === "sliding-control" || mode === "hook") {
        // Both slide: "hook" (library defaults + a 12 h cap written at creation) is renewed to
        // now + 7 days at the first read, because the library derives the session's age from
        // expiresAt - expiresIn. Recorded as a variant that does NOT hold.
        expect(r["+6h"]!.storedExpiry).not.toBe(atCreation);
        expect(r["+12h01m"]!.signedIn).toBe(true);
      } else {
        expect(r["+6h"]).toEqual({ signedIn: true, storedExpiry: atCreation });
        expect(r["+11h59m"]).toEqual({ signedIn: true, storedExpiry: atCreation });
        expect(r["+12h01m"]!.signedIn).toBe(false);
      }
    }

    // The other way of moving the clock: the stored expiry, real time.
    const w = await world("spike_p6_stored");
    const browser = new Browser(w.auth);
    await signIn(w, browser, USERS.verified);
    const live = Boolean(await getSession(w, browser));
    await w.q(`update session set expires_at = now() at time zone 'utc' - interval '1 minute'`);
    const ended = await getSession(w, browser);
    evidence("6-stored-expiry-moved", { before: live, after: ended });
    expect(live).toBe(true);
    expect(ended).toBeNull();
  });

  test("6b. at the provider, a second visit with the provider's own session comes back signed in without the form", async () => {
    const w = await world("spike_p6b");
    const provider = new ProviderBrowser();
    const first = await signIn(w, new Browser(w.auth), USERS.verified, provider);
    const second = await signIn(w, new Browser(w.auth), undefined, provider);
    evidence("6b", { first: { formShown: first.formShown, to: first.to }, second: { formShown: second.formShown, to: second.to }, rows: await w.counts() });
    expect(second.formShown).toBe(false);
    expect(second.to).toBe("/account/clients");
  });

  test("7. implicit linking disabled: a new subject with an existing account's address is refused, not linked", async () => {
    const w = await world("spike_p7");
    await signIn(w, new Browser(w.auth), USERS.verified);
    const before = await w.counts();
    const [first] = await w.q(`select account_id from account`);
    const b = new Browser(w.auth);
    const r = await signIn(w, b, USERS.reassigned);
    const after = await w.counts();
    const subjects = await w.q(`select account_id from account`);

    const c = await world("spike_p7_control", { disableImplicitLinking: false });
    await signIn(c, new Browser(c.auth), USERS.verified);
    const cr = await signIn(c, new Browser(c.auth), USERS.reassigned);
    const controlRows = await c.counts();
    evidence("7", {
      refused: { location: r.to, rowsBefore: before, rowsAfter: after, getSession: await getSession(w, b), subjectUnchanged: subjects.length === 1 && subjects[0]!["account_id"] === first!["account_id"] },
      validateUserInfoActions: w.events.filter((e) => e.hook === "validateUserInfo").map((e) => e["action"]),
      controlLinkingAsTheLibraryDoes: { location: cr.to, rows: controlRows, validateUserInfoActions: c.events.filter((e) => e.hook === "validateUserInfo").map((e) => e["action"]) },
    });
    expect(new URL(r.to, BASE).searchParams.get("error")).toBe("account_not_linked");
    expect(after).toEqual(before);
    expect(controlRows).toEqual({ users: 1, accounts: 2, sessions: 2 });
  });

  test("8. invalid_grant thrown from customTokenResponseFields leaves the presented refresh token usable", async () => {
    const w = await world("spike_p8", { renewalWindow: true });
    const REDIRECT = "http://127.0.0.1:33418/callback";
    const reg = await registerDynamic(w.auth, { client_name: "Spike CLI", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const browser = new Browser(w.auth);
    const { verifier, challenge } = pkce();
    const authorize = authorizePath({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "a2h offline_access", state: "st-1", code_challenge: challenge, code_challenge_method: "S256", resource: MCP });

    // Agent connection: authorize -> sign-in page -> provider -> callback -> authorize -> consent.
    const toLogin = await browser.request(authorize);
    const login = new URL(toLogin.headers.get("location")!, BASE);
    expect(login.pathname).toBe("/sign-in");
    const next = authorizeUrlFromLoginQuery(login.searchParams)!;
    const signedIn = await signIn(w, browser, USERS.verified, new ProviderBrowser(), next);
    expect(signedIn.to.startsWith("/api/auth/oauth2/authorize?")).toBe(true);
    const toConsent = await browser.request(signedIn.to);
    const consentUrl = new URL(toConsent.headers.get("location")!, BASE);
    expect(consentUrl.pathname).toBe("/consent");
    const request = await readConsentRequest(w.db, SECRET, consentUrl.searchParams);
    if (request.state !== "ready") throw new Error("consent not ready");
    const [u] = await w.q(`select id from "user"`);
    const userId = u!["id"] as string;
    // D8: the per-transaction instance is built without the provider plugin.
    const withoutProvider = { ...w.options };
    delete withoutProvider.idp;
    const authOn = (db: PrincipalsDb) => createSpikeAuth({ ...withoutProvider, db });
    const logger = createLogger({ write: () => undefined, level: "debug" });
    const back = new URL(await decideConsent({ db: w.db, baseURL: BASE, authOn, defaultPolicy: POLICY, logger, isAllowed: () => Promise.resolve(true) }, { accept: true, oauthQuery: request.oauthQuery, userId, headers: browser.headers() }));
    const code = back.searchParams.get("code")!;
    const issued = await token(w.auth, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: MCP });
    const tokens = (await issued.json()) as Record<string, string>;
    expect(issued.status, JSON.stringify(tokens)).toBe(200);
    const refresh = tokens["refresh_token"]!;
    const family = () => w.q(`select (revoked is not null) revoked, (rotated_at is not null) rotated from oauth_refresh_token order by created_at`);
    const familyAtIssue = await family();

    // Eight days without a sign-in at the provider.
    await w.q(`update "user" set last_idp_sign_in_at = $1 where id = $2`, [new Date(Date.now() - 8 * DAY), userId]);
    const stale = await token(w.auth, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: MCP });
    const staleBody = (await stale.json()) as Record<string, string>;
    const familyAfterRefusal = await family();
    const staleAgain = await token(w.auth, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: MCP });

    // The principal signs in at the provider again (callback writes the timestamp).
    await signIn(w, new Browser(w.auth), USERS.verified);
    const renewed = await token(w.auth, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: MCP });
    const renewedBody = (await renewed.json()) as Record<string, string>;
    const familyAfterRenewal = await family();
    evidence("8", {
      issued: { status: issued.status, hasRefreshToken: Boolean(refresh) },
      staleRefresh: { status: stale.status, body: staleBody },
      staleRefreshSecondAttempt: staleAgain.status,
      familyAtIssue,
      familyAfterRefusal,
      sameTokenAfterNewSignIn: { status: renewed.status, hasAccessToken: Boolean(renewedBody["access_token"]), rotated: Boolean(renewedBody["refresh_token"]) && renewedBody["refresh_token"] !== refresh },
      familyAfterRenewal,
      tokenHookCalls: w.events.filter((e) => e.hook === "customTokenResponseFields").map((e) => e["grantType"]),
    });
    expect(stale.status).toBe(400);
    expect(staleBody["error"]).toBe("invalid_grant");
    expect(familyAfterRefusal).toEqual(familyAtIssue);
    expect(familyAfterRefusal).toEqual([{ revoked: false, rotated: false }]);
    expect(renewed.status, JSON.stringify(renewedBody)).toBe(200);
  });
});
