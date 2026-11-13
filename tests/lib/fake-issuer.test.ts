// tests/lib/fake-issuer.ts proves itself (m2-org-sign-in task 7.1, design D10):
// a relying party written here with jose and fetch runs the authorization code
// flow against the fake issuer, then decodes and verifies what came back. Each
// fault must produce exactly what it claims and nothing else: a token with a
// wrong issuer still has a good signature, audience and expiry, and so on, so a
// sign-in test that goes red under a fault is red for that reason only.
// Run: pnpm --filter @a2h/tests test
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, decodeProtectedHeader, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import {
  FAULTS,
  PEOPLE,
  sameEmailNewSubject,
  startFakeIssuer,
  withChangedEmail,
  type FakeIssuer,
  type Fault,
  type TestPerson,
} from "./fake-issuer.ts";

const CLIENT_ID = "a2h-test";
const CLIENT_SECRET = "fake-issuer-test-secret";
const REDIRECT = "http://localhost:3000/api/auth/callback/idp";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token: string;
  scope: string;
}

async function discover(idp: FakeIssuer): Promise<Discovery> {
  const res = await fetch(idp.discoveryUrl);
  assert.equal(res.status, 200);
  return (await res.json()) as Discovery;
}

interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  url: string;
}

/** What a relying party sends to the authorization endpoint. `omit` and `set` bend it for the refusals. */
function attempt(d: Discovery, change: { omit?: string[]; set?: Record<string, string> } = {}): Attempt {
  const state = randomBytes(12).toString("base64url");
  const nonce = randomBytes(12).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...(change.set ?? {}),
  });
  for (const name of change.omit ?? []) q.delete(name);
  return { state, nonce, verifier, url: `${d.authorization_endpoint}?${q.toString()}` };
}

/** Follow the authorization endpoint without a browser: the redirect it answers with. */
async function callbackOf(a: Attempt): Promise<URL> {
  const res = await fetch(a.url, { redirect: "manual" });
  assert.equal(res.status, 302, `the authorization endpoint redirects (got ${res.status}: ${await res.text()})`);
  const location = res.headers.get("location");
  assert.ok(location, "a Location header");
  return new URL(location);
}

function tokenRequest(d: Discovery, body: Record<string, string>, auth: "basic" | "post" | "none" = "basic", secret = CLIENT_SECRET): Promise<Response> {
  const form = new URLSearchParams(body);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (auth === "basic") headers.authorization = `Basic ${Buffer.from(`${CLIENT_ID}:${secret}`).toString("base64")}`;
  if (auth === "post") {
    form.set("client_id", CLIENT_ID);
    form.set("client_secret", secret);
  }
  return fetch(d.token_endpoint, { method: "POST", headers, body: form });
}

async function exchange(d: Discovery, a: Attempt, code: string): Promise<TokenResponse> {
  const res = await tokenRequest(d, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: a.verifier });
  assert.equal(res.status, 200, `token endpoint: ${await res.clone().text()}`);
  return (await res.json()) as TokenResponse;
}

/** The whole flow for the person and fault selected on the issuer. */
async function signIn(idp: FakeIssuer): Promise<{ attempt: Attempt; tokens: TokenResponse; claims: JWTPayload }> {
  const d = await discover(idp);
  const a = attempt(d);
  const cb = await callbackOf(a);
  assert.equal(cb.origin + cb.pathname, REDIRECT);
  const code = cb.searchParams.get("code");
  assert.ok(code, `a code in the callback (got ${cb.search})`);
  const tokens = await exchange(d, a, code);
  return { attempt: a, tokens, claims: decodeJwt(tokens.id_token) };
}

/** Verify as a relying party does: signature against the published JWKS, issuer, audience, expiry. */
async function verify(idp: FakeIssuer, idToken: string, relax: { issuer?: boolean; audience?: boolean } = {}): Promise<JWTPayload> {
  const d = await discover(idp);
  const jwks = createRemoteJWKSet(new URL(d.jwks_uri));
  const { payload } = await jwtVerify(idToken, jwks, {
    algorithms: d.id_token_signing_alg_values_supported,
    ...(relax.issuer ? {} : { issuer: d.issuer }),
    ...(relax.audience ? {} : { audience: CLIENT_ID }),
    requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
  });
  return payload;
}

async function userinfo(d: Discovery, accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail("expected a rejection");
}

/** The fake's own refusals since the last look, acknowledged: "endpoint error". */
function refusalsOf(idp: FakeIssuer): string[] {
  return idp.takeRefusals().map((r) => `${r.endpoint} ${r.error}`);
}

const alpha = PEOPLE.alpha;
const bravo = PEOPLE.bravo;

describe("fake issuer", () => {
  let idp: FakeIssuer;

  before(async () => {
    idp = await startFakeIssuer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [REDIRECT] });
  });
  after(async () => {
    await idp.close();
  });
  beforeEach(async () => {
    await idp.reset();
  });

  describe("an ordinary provider", () => {
    test("listens on a local port and publishes a discovery document for its own issuer", async () => {
      assert.match(idp.issuer, /^http:\/\/127\.0\.0\.1:[1-9][0-9]+$/);
      assert.equal(idp.discoveryUrl, `${idp.issuer}/.well-known/openid-configuration`);
      const d = await discover(idp);
      assert.equal(d.issuer, idp.issuer);
      for (const endpoint of [d.authorization_endpoint, d.token_endpoint, d.userinfo_endpoint, d.jwks_uri]) {
        assert.ok(endpoint.startsWith(`${idp.issuer}/`), endpoint);
      }
      assert.deepEqual(d.response_types_supported, ["code"]);
      assert.deepEqual(d.subject_types_supported, ["public"]);
      assert.deepEqual(d.id_token_signing_alg_values_supported, ["RS256"]);
      assert.deepEqual(d.code_challenge_methods_supported, ["S256"]);
      assert.deepEqual(d.token_endpoint_auth_methods_supported, ["client_secret_basic", "client_secret_post"]);
      assert.ok(d.scopes_supported.includes("openid"));
    });

    test("the JWKS holds public signing keys only", async () => {
      const d = await discover(idp);
      const jwks = (await (await fetch(d.jwks_uri)).json()) as { keys: Record<string, unknown>[] };
      assert.equal(jwks.keys.length, 1);
      const key = jwks.keys[0]!;
      assert.equal(key.kty, "RSA");
      assert.equal(key.use, "sig");
      assert.equal(key.alg, "RS256");
      assert.equal(typeof key.kid, "string");
      for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) assert.equal(key[secret], undefined, `no private member ${secret}`);
    });

    test("keys are made at start: two issuers do not share one", async () => {
      const other = await startFakeIssuer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      try {
        other.signInAs(alpha);
        const { tokens } = await signIn(other);
        const error = await rejection(verify(idp, tokens.id_token, { issuer: true }));
        assert.ok(error instanceof errors.JOSEError, String(error));
        assert.notEqual(other.issuer, idp.issuer);
      } finally {
        await other.close();
      }
    });

    test("redirects back at once with a code and the state, for the chosen person", async () => {
      idp.signInAs(alpha);
      const d = await discover(idp);
      const a = attempt(d);
      const cb = await callbackOf(a);
      assert.equal(cb.origin + cb.pathname, REDIRECT);
      assert.equal(cb.searchParams.get("state"), a.state);
      assert.ok(cb.searchParams.get("code"));
      assert.equal(cb.searchParams.get("error"), null);
      assert.equal(idp.lastCallback, cb.toString());
    });

    test("the ID token verifies against the JWKS and carries the person, the nonce and the times", async () => {
      idp.signInAs(alpha);
      const before = Math.floor(Date.now() / 1000);
      const { attempt: a, tokens } = await signIn(idp);
      const claims = await verify(idp, tokens.id_token);
      assert.equal(claims.iss, idp.issuer);
      assert.equal(claims.aud, CLIENT_ID);
      assert.equal(claims.sub, alpha.sub);
      assert.equal(claims.email, alpha.email);
      assert.equal(claims.email_verified, true);
      assert.equal(claims.name, alpha.name);
      assert.equal(claims.nonce, a.nonce);
      assert.ok(claims.iat! >= before - 1 && claims.iat! <= before + 5);
      assert.equal(claims.exp! - claims.iat!, 300);
      assert.equal(claims.auth_time, claims.iat);
      const header = decodeProtectedHeader(tokens.id_token);
      assert.equal(header.alg, "RS256");
      assert.equal(tokens.token_type, "Bearer");
      assert.equal(tokens.scope, "openid email profile");
      assert.equal((tokens as unknown as Record<string, unknown>).refresh_token, undefined, "no refresh token: offline_access is never granted");
    });

    test("userinfo answers the bearer of the access token with the same person", async () => {
      idp.signInAs(bravo);
      const { tokens } = await signIn(idp);
      const d = await discover(idp);
      assert.deepEqual(await userinfo(d, tokens.access_token), { sub: bravo.sub, email: bravo.email, email_verified: true, name: bravo.name });
      const anonymous = await fetch(d.userinfo_endpoint);
      assert.equal(anonymous.status, 401);
      const forged = await fetch(d.userinfo_endpoint, { headers: { authorization: "Bearer not-a-token" } });
      assert.equal(forged.status, 401);
      assert.deepEqual(refusalsOf(idp), ["userinfo invalid_token", "userinfo invalid_token"]);
    });

    test("the selection holds until changed, and each sign-in is recorded with its tokens", async () => {
      idp.signInAs(alpha);
      const first = await signIn(idp);
      const second = await signIn(idp);
      idp.signInAs(bravo);
      const third = await signIn(idp);
      assert.deepEqual(
        idp.issued.map((i) => [i.person.sub, i.fault, i.idToken, i.accessToken]),
        [first, second, third].map((s, n) => [n < 2 ? alpha.sub : bravo.sub, undefined, s.tokens.id_token, s.tokens.access_token]),
      );
    });

    test("without a selected person the authorization endpoint says so instead of guessing", async () => {
      const d = await discover(idp);
      const res = await fetch(attempt(d).url, { redirect: "manual" });
      assert.equal(res.status, 500);
      assert.match(await res.text(), /signInAs/);
      assert.deepEqual(refusalsOf(idp), ["authorize no_person_selected"]);
    });

    test("every request is recorded by method and path, without its query", async () => {
      idp.signInAs(alpha);
      await signIn(idp);
      assert.deepEqual(
        idp.requests.map((r) => `${r.method} ${r.path}`),
        ["GET /.well-known/openid-configuration", "GET /authorize", "POST /token"],
      );
    });

    test("authorize() follows an authorization URL and returns the callback", async () => {
      idp.signInAs(alpha);
      const a = attempt(await discover(idp));
      const cb = await idp.authorize(a.url);
      assert.equal(cb.searchParams.get("state"), a.state);
      await assert.rejects(idp.authorize(`${idp.issuer}/authorize?client_id=someone-else`), /refused.*unknown_client/);
      assert.deepEqual(refusalsOf(idp), ["authorize unknown_client"]);
      await assert.rejects(idp.authorize("https://elsewhere.example/authorize"), /not this issuer/);
    });
  });

  describe("what it requires of the relying party", () => {
    async function refusedAtToken(body: Record<string, string>, auth: "basic" | "post" | "none" = "basic", secret = CLIENT_SECRET): Promise<{ status: number; error: string }> {
      const d = await discover(idp);
      const res = await tokenRequest(d, body, auth, secret);
      return { status: res.status, error: ((await res.json()) as { error: string }).error };
    }

    async function freshCode(change?: Parameters<typeof attempt>[1]): Promise<{ a: Attempt; code: string }> {
      idp.signInAs(alpha);
      const a = attempt(await discover(idp), change);
      const code = (await callbackOf(a)).searchParams.get("code");
      assert.ok(code);
      return { a, code };
    }

    test("PKCE: the token endpoint refuses a wrong verifier and a missing one", async () => {
      const { code } = await freshCode();
      assert.deepEqual(
        await refusedAtToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: randomBytes(32).toString("base64url") }),
        { status: 400, error: "invalid_grant" },
      );
      const again = await freshCode();
      assert.deepEqual(await refusedAtToken({ grant_type: "authorization_code", code: again.code, redirect_uri: REDIRECT }), { status: 400, error: "invalid_grant" });
      assert.equal(idp.issued.length, 0);
      assert.deepEqual(refusalsOf(idp), ["token invalid_grant", "token invalid_grant"]);
    });

    test("PKCE: the authorization endpoint refuses a request without an S256 challenge", async () => {
      idp.signInAs(alpha);
      const d = await discover(idp);
      for (const change of [{ omit: ["code_challenge", "code_challenge_method"] }, { set: { code_challenge_method: "plain" } }]) {
        const a = attempt(d, change);
        const cb = await callbackOf(a);
        assert.equal(cb.searchParams.get("error"), "invalid_request");
        assert.equal(cb.searchParams.get("state"), a.state);
        assert.equal(cb.searchParams.get("code"), null);
      }
      assert.deepEqual(refusalsOf(idp), ["authorize invalid_request", "authorize invalid_request"]);
    });

    test("a code works once", async () => {
      const { a, code } = await freshCode();
      await exchange(await discover(idp), a, code);
      assert.deepEqual(await refusedAtToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: a.verifier }), { status: 400, error: "invalid_grant" });
      assert.deepEqual(refusalsOf(idp), ["token invalid_grant"]);
    });

    test("the client authenticates with its secret, by Basic or in the body", async () => {
      const { a, code } = await freshCode();
      const body = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: a.verifier };
      assert.deepEqual(await refusedAtToken(body, "basic", "wrong"), { status: 401, error: "invalid_client" });
      assert.deepEqual(await refusedAtToken(body, "none"), { status: 401, error: "invalid_client" });
      const res = await tokenRequest(await discover(idp), body, "post");
      assert.equal(res.status, 200, "a refused client authentication does not burn the code");
      assert.deepEqual(refusalsOf(idp), ["token invalid_client", "token invalid_client"]);
    });

    test("the redirect address at the token endpoint is the one of the authorization request", async () => {
      const { a, code } = await freshCode();
      assert.deepEqual(
        await refusedAtToken({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/elsewhere", code_verifier: a.verifier }),
        { status: 400, error: "invalid_grant" },
      );
      assert.deepEqual(refusalsOf(idp), ["token invalid_grant"]);
    });

    test("only the authorization code grant", async () => {
      assert.deepEqual(await refusedAtToken({ grant_type: "refresh_token", refresh_token: "x" }), { status: 400, error: "unsupported_grant_type" });
      assert.deepEqual(refusalsOf(idp), ["token unsupported_grant_type"]);
    });

    test("an unknown client or an unregistered redirect address gets a page, never a redirect", async () => {
      idp.signInAs(alpha);
      const d = await discover(idp);
      for (const set of [{ client_id: "someone-else" }, { redirect_uri: "http://localhost:3000/elsewhere" }]) {
        const res = await fetch(attempt(d, { set }).url, { redirect: "manual" });
        assert.equal(res.status, 400);
        assert.equal(res.headers.get("location"), null);
      }
      assert.deepEqual(refusalsOf(idp), ["authorize unknown_client", "authorize unregistered_redirect_uri"]);
    });

    test("without registered redirect addresses any is accepted", async () => {
      const open = await startFakeIssuer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      try {
        open.signInAs(alpha);
        const cb = await callbackOf(attempt(await discover(open), { set: { redirect_uri: "http://localhost:4567/cb" } }));
        assert.equal(cb.origin + cb.pathname, "http://localhost:4567/cb");
      } finally {
        await open.close();
      }
    });

    test("response type and the openid scope are required", async () => {
      idp.signInAs(alpha);
      const d = await discover(idp);
      assert.equal((await callbackOf(attempt(d, { set: { response_type: "token" } }))).searchParams.get("error"), "unsupported_response_type");
      assert.equal((await callbackOf(attempt(d, { set: { scope: "email" } }))).searchParams.get("error"), "invalid_scope");
      assert.deepEqual(refusalsOf(idp), ["authorize unsupported_response_type", "authorize invalid_scope"]);
    });
  });

  describe("faults: the email address (scenario: Email address not verified)", () => {
    test("no_email: neither the ID token nor userinfo carries an address or a verified claim; the token is otherwise good", async () => {
      idp.signInAs(alpha, "no_email");
      const { tokens } = await signIn(idp);
      const claims = await verify(idp, tokens.id_token);
      assert.equal(claims.sub, alpha.sub);
      assert.equal("email" in claims, false);
      assert.equal("email_verified" in claims, false);
      assert.deepEqual(await userinfo(await discover(idp), tokens.access_token), { sub: alpha.sub, name: alpha.name });
    });

    test("email_unverified: the address is there and asserted as not verified, in the token and in userinfo", async () => {
      idp.signInAs(alpha, "email_unverified");
      const { tokens } = await signIn(idp);
      const claims = await verify(idp, tokens.id_token);
      assert.equal(claims.email, alpha.email);
      assert.equal(claims.email_verified, false);
      assert.equal((await userinfo(await discover(idp), tokens.access_token)).email_verified, false);
    });

    test("no_verified_claim: the address is there with no assertion about it at all", async () => {
      idp.signInAs(alpha, "no_verified_claim");
      const { tokens } = await signIn(idp);
      const claims = await verify(idp, tokens.id_token);
      assert.equal(claims.email, alpha.email);
      assert.equal("email_verified" in claims, false);
      assert.equal("email_verified" in (await userinfo(await discover(idp), tokens.access_token)), false);
    });

    test("a person can be unverified, or verified as the string Google's example shows, without a fault", async () => {
      idp.signInAs({ ...alpha, emailVerified: false });
      assert.equal((await signIn(idp)).claims.email_verified, false);
      idp.signInAs({ ...alpha, emailVerified: "true" });
      assert.equal((await signIn(idp)).claims.email_verified, "true");
    });
  });

  describe("the name of the verified claim (Microsoft Entra ID: xms_edov)", () => {
    let entra: FakeIssuer;
    before(async () => {
      entra = await startFakeIssuer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [REDIRECT], emailVerifiedClaim: "xms_edov" });
    });
    after(async () => {
      await entra.close();
    });
    beforeEach(async () => {
      await entra.reset();
    });

    test("the assertion travels under the configured name and email_verified is absent", async () => {
      entra.signInAs(alpha);
      const { tokens } = await signIn(entra);
      const claims = await verify(entra, tokens.id_token);
      assert.equal(claims.email, alpha.email);
      assert.equal(claims.xms_edov, true);
      assert.equal("email_verified" in claims, false);
      assert.deepEqual(await userinfo(await discover(entra), tokens.access_token), { sub: alpha.sub, email: alpha.email, xms_edov: true, name: alpha.name });
    });

    test("the email faults follow the configured name", async () => {
      entra.signInAs(alpha, "email_unverified");
      const unverified = (await signIn(entra)).claims;
      assert.equal(unverified.xms_edov, false);
      assert.equal("email_verified" in unverified, false);
      entra.signInAs(alpha, "no_verified_claim");
      const silent = (await signIn(entra)).claims;
      assert.equal(silent.email, alpha.email);
      assert.equal("xms_edov" in silent, false);
      entra.signInAs(alpha, "no_email");
      const none = (await signIn(entra)).claims;
      assert.equal("email" in none, false);
      assert.equal("xms_edov" in none, false);
    });
  });

  describe("faults: an answer not meant for this install", () => {
    test("wrong_issuer: verification fails on iss and on nothing else", async () => {
      idp.signInAs(alpha, "wrong_issuer");
      const { tokens, attempt: a } = await signIn(idp);
      const error = await rejection(verify(idp, tokens.id_token));
      assert.ok(error instanceof errors.JWTClaimValidationFailed, String(error));
      assert.equal(error.claim, "iss");
      const claims = await verify(idp, tokens.id_token, { issuer: true });
      assert.notEqual(claims.iss, idp.issuer);
      assert.equal(claims.sub, alpha.sub);
      assert.equal(claims.email_verified, true);
      assert.equal(claims.nonce, a.nonce);
    });

    test("wrong_audience: verification fails on aud and on nothing else", async () => {
      idp.signInAs(alpha, "wrong_audience");
      const { tokens, attempt: a } = await signIn(idp);
      const error = await rejection(verify(idp, tokens.id_token));
      assert.ok(error instanceof errors.JWTClaimValidationFailed, String(error));
      assert.equal(error.claim, "aud");
      const claims = await verify(idp, tokens.id_token, { audience: true });
      assert.notEqual(claims.aud, CLIENT_ID);
      assert.equal(typeof claims.aud, "string");
      assert.equal(claims.iss, idp.issuer);
      assert.equal(claims.nonce, a.nonce);
    });

    test("expired: verification fails on exp, an hour past, and on nothing else", async () => {
      idp.signInAs(alpha, "expired");
      const { tokens, claims, attempt: a } = await signIn(idp);
      const error = await rejection(verify(idp, tokens.id_token));
      assert.ok(error instanceof errors.JWTExpired, String(error));
      const now = Math.floor(Date.now() / 1000);
      assert.ok(claims.exp! <= now - 3600 + 5, "well beyond any clock tolerance");
      assert.ok(claims.iat! < claims.exp!);
      // Signature, issuer and audience are good: the same token verifies at the time it claims to be issued.
      const d = await discover(idp);
      const then = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(d.jwks_uri)), { issuer: d.issuer, audience: CLIENT_ID, currentDate: new Date(claims.iat! * 1000) });
      assert.equal(then.payload.nonce, a.nonce);
    });

    test("wrong_key: same key id, another key; the signature fails and every claim is good", async () => {
      idp.signInAs(alpha, "wrong_key");
      const { tokens, claims, attempt: a } = await signIn(idp);
      const d = await discover(idp);
      const jwks = (await (await fetch(d.jwks_uri)).json()) as JSONWebKeySet;
      assert.equal(decodeProtectedHeader(tokens.id_token).kid, jwks.keys[0]!.kid, "the verifier finds a key and must check the signature");
      const error = await rejection(verify(idp, tokens.id_token));
      assert.ok(error instanceof errors.JWSSignatureVerificationFailed, String(error));
      assert.equal(claims.iss, idp.issuer);
      assert.equal(claims.aud, CLIENT_ID);
      assert.equal(claims.sub, alpha.sub);
      assert.equal(claims.nonce, a.nonce);
      assert.ok(claims.exp! > Math.floor(Date.now() / 1000));
      // It is a real signature by a real key, not noise: it verifies against the key that made it.
      const forged = await jwtVerify(tokens.id_token, createLocalJWKSet({ keys: [idp.otherKey] }), { issuer: d.issuer, audience: CLIENT_ID });
      assert.equal(forged.payload.sub, alpha.sub);
    });

    test("wrong_nonce: a good token for another request", async () => {
      idp.signInAs(alpha, "wrong_nonce");
      const { tokens, attempt: a } = await signIn(idp);
      const claims = await verify(idp, tokens.id_token);
      assert.equal(typeof claims.nonce, "string");
      assert.notEqual(claims.nonce, a.nonce);
    });

    test("wrong_state: the callback carries a code and a state the relying party did not send", async () => {
      idp.signInAs(alpha, "wrong_state");
      const a = attempt(await discover(idp));
      const cb = await callbackOf(a);
      assert.ok(cb.searchParams.get("code"));
      assert.ok(cb.searchParams.get("state"));
      assert.notEqual(cb.searchParams.get("state"), a.state);
    });
  });

  describe("faults: the person cancels or the provider refuses", () => {
    test("cancelled: access_denied comes back to the callback with the state and no code", async () => {
      idp.signInAs(alpha, "cancelled");
      const a = attempt(await discover(idp));
      const cb = await callbackOf(a);
      assert.equal(cb.origin + cb.pathname, REDIRECT);
      assert.equal(cb.searchParams.get("error"), "access_denied");
      assert.equal(cb.searchParams.get("state"), a.state);
      assert.equal(cb.searchParams.get("code"), null);
      assert.equal(idp.issued.length, 0);
    });

    test("provider_error: server_error comes back the same way", async () => {
      idp.signInAs(alpha, "provider_error");
      const a = attempt(await discover(idp));
      const cb = await callbackOf(a);
      assert.equal(cb.searchParams.get("error"), "server_error");
      assert.equal(cb.searchParams.get("state"), a.state);
      assert.equal(cb.searchParams.get("code"), null);
    });
  });

  describe("faults: the provider cannot be reached", () => {
    test("refused: nothing listens on the port; recover() brings the same issuer back with the same keys", async () => {
      idp.signInAs(alpha);
      const { tokens } = await signIn(idp);
      await idp.outage("refused");
      const error = await rejection(fetch(idp.discoveryUrl));
      assert.ok(error instanceof TypeError, String(error));
      assert.equal((error.cause as { code?: string }).code, "ECONNREFUSED");
      await idp.recover();
      assert.equal((await discover(idp)).issuer, idp.issuer);
      await verify(idp, tokens.id_token);
    });

    test("hang: every endpoint accepts the connection and never answers; recover() ends it", async () => {
      await idp.outage("hang");
      for (const path of ["/.well-known/openid-configuration", "/jwks", "/authorize", "/token", "/userinfo"]) {
        const started = Date.now();
        const error = await rejection(fetch(`${idp.issuer}${path}`, { signal: AbortSignal.timeout(300) }));
        assert.equal((error as Error).name, "TimeoutError", path);
        assert.ok(Date.now() - started >= 290, `${path} was held open`);
      }
      const held = fetch(idp.discoveryUrl);
      held.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      await idp.recover();
      await assert.rejects(held, "a request held during the outage is dropped, not answered late");
      assert.equal((await discover(idp)).issuer, idp.issuer);
    });

    test("reset() ends an outage and forgets the selection, the records and the codes", async () => {
      idp.signInAs(alpha, "cancelled");
      const d = await discover(idp);
      await callbackOf(attempt(d));
      await idp.outage("refused");
      await idp.reset();
      assert.deepEqual(idp.requests, []);
      assert.deepEqual(idp.issued, []);
      assert.equal(idp.lastCallback, undefined);
      assert.deepEqual(idp.delivered, []);
      assert.equal((await fetch(attempt(d).url, { redirect: "manual" })).status, 500);
      assert.deepEqual(refusalsOf(idp), ["authorize no_person_selected"]);
    });

    test("close() is final and can be called twice", async () => {
      const gone = await startFakeIssuer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      await gone.outage("hang");
      await gone.close();
      await gone.close();
      await assert.rejects(fetch(gone.discoveryUrl));
      await assert.rejects(gone.recover(), /closed/);
    });
  });

  describe("people (scenarios: recognised by the provider's identifier; never matched by email address alone)", () => {
    test("every fixture is invented: a reserved domain, a distinct subject and address", () => {
      const people: TestPerson[] = Object.values(PEOPLE);
      assert.ok(people.length >= 3);
      for (const p of people) assert.match(p.email, /^[a-z.]+@a2h-fake-idp\.example$/, "RFC 2606 reserved: no mailbox can exist");
      assert.equal(new Set(people.map((p) => p.sub)).size, people.length);
      assert.equal(new Set(people.map((p) => p.email)).size, people.length);
    });

    test("sameEmailNewSubject: a second subject carrying an existing person's address", async () => {
      const impostor = sameEmailNewSubject(alpha);
      assert.equal(impostor.email, alpha.email);
      assert.notEqual(impostor.sub, alpha.sub);
      assert.notEqual(sameEmailNewSubject(alpha).sub, impostor.sub, "a new subject each time");
      idp.signInAs(impostor);
      const { tokens } = await signIn(idp);
      const claims = await verify(idp, tokens.id_token);
      assert.equal(claims.sub, impostor.sub);
      assert.equal(claims.email, alpha.email);
      assert.equal(claims.email_verified, true);
    });

    test("withChangedEmail: the same subject with another address", async () => {
      const moved = withChangedEmail(alpha, "alpha.renamed@a2h-fake-idp.example");
      assert.equal(moved.sub, alpha.sub);
      assert.equal(moved.name, alpha.name);
      idp.signInAs(moved);
      const { tokens } = await signIn(idp);
      const claims = await verify(idp, tokens.id_token);
      assert.equal(claims.sub, alpha.sub);
      assert.equal(claims.email, "alpha.renamed@a2h-fake-idp.example");
      assert.equal(alpha.email, "alpha@a2h-fake-idp.example", "the fixture itself is not changed");
    });
  });

  describe("tokens minted without a flow (for posting a raw ID token)", () => {
    test("mintIdToken signs for a person with the nonce given, and takes the token faults", async () => {
      const good = await idp.mintIdToken(bravo, { nonce: "n-1" });
      const claims = await verify(idp, good);
      assert.equal(claims.sub, bravo.sub);
      assert.equal(claims.nonce, "n-1");
      const bare = await verify(idp, await idp.mintIdToken(bravo));
      assert.equal("nonce" in bare, false);
      const forged = await idp.mintIdToken(bravo, { fault: "wrong_key" });
      assert.ok((await rejection(verify(idp, forged))) instanceof errors.JWSSignatureVerificationFailed);
      assert.equal(idp.issued.length, 0, "only sign-ins through the flow are recorded");
    });
  });

  describe("its own refusals are loud: a test cannot pass on a refusal it did not ask for", () => {
    // A relying party that sends something the fake rejects gets an error at
    // its callback, which looks like "cancelled" to the application. Without
    // these guards every refusal test would pass with its fault undelivered.
    const NO_PKCE = { omit: ["code_challenge", "code_challenge_method"] };

    test("a refusal is recorded with its endpoint, code and reason, and is marked in what the application receives", async () => {
      idp.signInAs(alpha, "wrong_audience");
      const d = await discover(idp);
      const cb = await callbackOf(attempt(d, NO_PKCE));
      assert.equal(cb.searchParams.get("error"), "invalid_request");
      assert.match(cb.searchParams.get("error_description") ?? "", /^fake issuer refused: /);
      assert.deepEqual(idp.refusals, [{ endpoint: "authorize", error: "invalid_request", description: "PKCE with S256 is required" }]);
      const res = await tokenRequest(d, { grant_type: "authorization_code", code: "nope", redirect_uri: REDIRECT, code_verifier: "x" });
      assert.match(((await res.json()) as { error_description: string }).error_description, /^fake issuer refused: /);
      assert.deepEqual(refusalsOf(idp), ["authorize invalid_request", "token invalid_grant"]);
      assert.deepEqual(idp.refusals, [], "taken once");
    });

    test("a requested fault is not a refusal: cancelled and provider_error carry no such mark", async () => {
      const d = await discover(idp);
      for (const fault of ["cancelled", "provider_error"] as const) {
        idp.signInAs(alpha, fault);
        const cb = await callbackOf(attempt(d));
        assert.equal(cb.searchParams.get("error_description"), null);
      }
      assert.deepEqual(idp.refusals, []);
    });

    test("authorize() throws on a refusal instead of handing its redirect to the application", async () => {
      idp.signInAs(alpha, "cancelled");
      const d = await discover(idp);
      await assert.rejects(idp.authorize(attempt(d, NO_PKCE).url), /fake issuer refused.*invalid_request.*PKCE/);
      await assert.rejects(idp.authorize(attempt(d, { set: { scope: "email" } }).url), /fake issuer refused.*invalid_scope/);
      idp.takeRefusals();
      const cb = await idp.authorize(attempt(d).url);
      assert.equal(cb.searchParams.get("error"), "access_denied", "the requested fault still comes back as a redirect");
    });

    test("expectDelivered passes only when that fault was the last answer given and nothing was refused", async () => {
      const d = await discover(idp);
      assert.throws(() => idp.expectDelivered("wrong_audience"), /nothing was delivered/);

      // A token fault counts when the token response left, not when the code did.
      idp.signInAs(alpha, "wrong_audience");
      const a = attempt(d);
      const code = (await callbackOf(a)).searchParams.get("code")!;
      assert.throws(() => idp.expectDelivered("wrong_audience"), /nothing was delivered/);
      await exchange(d, a, code);
      idp.expectDelivered("wrong_audience");
      assert.throws(() => idp.expectDelivered("wrong_issuer"), /wrong_audience.*not.*wrong_issuer|wrong_issuer/);
      assert.throws(() => idp.expectDelivered(), /wrong_audience/);
      assert.deepEqual(idp.delivered, [{ person: alpha, fault: "wrong_audience", at: "token" }]);

      // Callback faults count when the redirect left.
      for (const fault of ["cancelled", "provider_error", "wrong_state"] as const) {
        idp.signInAs(bravo, fault);
        await callbackOf(attempt(d));
        idp.expectDelivered(fault);
        assert.deepEqual(idp.delivered.at(-1), { person: bravo, fault, at: "callback" });
      }

      // No fault: the good answer was delivered.
      idp.signInAs(alpha);
      await signIn(idp);
      idp.expectDelivered();
      assert.throws(() => idp.expectDelivered("cancelled"), /no fault/);
    });

    test("the masking case: a refusal test whose request the fake rejected fails at expectDelivered", async () => {
      // What a broken relying party produces: no PKCE. The application sees an
      // error at its callback and shows its sign-in page, exactly as for "cancelled".
      idp.signInAs(alpha, "cancelled");
      const cb = await callbackOf(attempt(await discover(idp), NO_PKCE));
      assert.ok(cb.searchParams.get("error"), "looks like the fault to the application");
      assert.throws(() => idp.expectDelivered("cancelled"), /refused.*authorize invalid_request.*PKCE/s);
      idp.takeRefusals();
    });

    test("a refusal after a delivered fault still fails expectDelivered", async () => {
      idp.signInAs(alpha, "no_email");
      const { tokens } = await signIn(idp);
      idp.expectDelivered("no_email");
      await fetch((await discover(idp)).userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}x` } });
      assert.throws(() => idp.expectDelivered("no_email"), /refused.*userinfo invalid_token/s);
      idp.takeRefusals();
    });

    test("an endpoint the fake does not have is a refusal too (a relying party calling revocation or logout)", async () => {
      const res = await fetch(`${idp.issuer}/revoke`, { method: "POST" });
      assert.equal(res.status, 404);
      assert.match(await res.text(), /^fake issuer refused: /);
      assert.deepEqual(idp.refusals, [{ endpoint: "other", error: "unknown_endpoint", description: "POST /revoke" }]);
      assert.throws(() => idp.expectDelivered(), /refused.*other unknown_endpoint.*POST \/revoke/s);
      idp.takeRefusals();
    });

    test("reset() and close() fail on refusals nobody looked at, after doing their work", async () => {
      const d = await discover(idp);
      idp.signInAs(alpha);
      await callbackOf(attempt(d, NO_PKCE));
      await assert.rejects(idp.reset(), /1 refusal.*no test asked for.*authorize invalid_request/s);
      assert.deepEqual(idp.refusals, [], "the reset happened: the next test starts clean");
      await idp.reset();

      const other = await startFakeIssuer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      await fetch(`${other.issuer}/authorize?client_id=someone-else`);
      await assert.rejects(other.close(), /1 refusal.*no test asked for.*authorize unknown_client/s);
      await assert.rejects(fetch(other.discoveryUrl), "closed all the same");
      await other.close();
    });
  });

  describe("a code accepted twice (scenario: an answer already used)", () => {
    test("allowCodeReuse: the second exchange succeeds, so a replayed callback is stopped by the application or by nothing", async () => {
      idp.signInAs(alpha);
      idp.allowCodeReuse();
      const d = await discover(idp);
      const a = attempt(d);
      const code = (await callbackOf(a)).searchParams.get("code")!;
      const first = await exchange(d, a, code);
      const second = await exchange(d, a, code);
      assert.equal((await verify(idp, second.id_token)).sub, alpha.sub);
      assert.notEqual(second.access_token, first.access_token);
      assert.equal(idp.issued.length, 2);
      assert.deepEqual(idp.refusals, []);
      // PKCE and the redirect address are still checked on every exchange.
      const res = await tokenRequest(d, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "wrong" });
      assert.equal(res.status, 400);
      assert.deepEqual(refusalsOf(idp), ["token invalid_grant"]);
    });

    test("reset() makes codes single-use again", async () => {
      idp.allowCodeReuse();
      await idp.reset();
      idp.signInAs(alpha);
      const d = await discover(idp);
      const a = attempt(d);
      const code = (await callbackOf(a)).searchParams.get("code")!;
      await exchange(d, a, code);
      const res = await tokenRequest(d, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: a.verifier });
      assert.equal(res.status, 400);
      assert.deepEqual(refusalsOf(idp), ["token invalid_grant"]);
    });
  });

  describe("recover() when the port was taken meanwhile", () => {
    function squat(port: number): Promise<Server> {
      return new Promise((resolve, reject) => {
        const squatter = createServer();
        squatter.once("error", reject);
        squatter.listen(port, "127.0.0.1", () => resolve(squatter));
      });
    }
    const release = (squatter: Server): Promise<void> => new Promise((resolve) => squatter.close(() => resolve()));

    test("it retries until the port is free again", async () => {
      await idp.outage("refused");
      const squatter = await squat(Number(new URL(idp.issuer).port));
      setTimeout(() => void release(squatter), 200);
      await idp.recover();
      assert.equal((await discover(idp)).issuer, idp.issuer);
    });

    test("it gives up with a message that names the port, and can be tried again", async () => {
      const port = new URL(idp.issuer).port;
      await idp.outage("refused");
      const squatter = await squat(Number(port));
      try {
        await assert.rejects(idp.recover(), new RegExp(`port ${port} .*in use`));
      } finally {
        await release(squatter);
      }
      await idp.recover();
      assert.equal((await discover(idp)).issuer, idp.issuer);
    });
  });

  describe("claims set by hand on a person (the verified claim independently of email_verified)", () => {
    test("email_verified true with xms_edov false, and the reverse, in the token and in userinfo", async () => {
      const d = await discover(idp);
      for (const [emailVerified, edov] of [[true, false], [false, true]] as const) {
        idp.signInAs({ ...alpha, claims: { email_verified: emailVerified, xms_edov: edov } });
        const { tokens } = await signIn(idp);
        const claims = await verify(idp, tokens.id_token);
        assert.equal(claims.email_verified, emailVerified);
        assert.equal(claims.xms_edov, edov);
        assert.equal(claims.email, alpha.email);
        const info = await userinfo(d, tokens.access_token);
        assert.equal(info.email_verified, emailVerified);
        assert.equal(info.xms_edov, edov);
      }
    });

    test("an undefined value removes a claim; faults still apply to the configured claim first", async () => {
      idp.signInAs({ ...alpha, claims: { name: undefined, department: "Testing" } });
      const plain = (await signIn(idp)).claims;
      assert.equal("name" in plain, false);
      assert.equal(plain.department, "Testing");
      idp.signInAs({ ...alpha, claims: { xms_edov: true } }, "email_unverified");
      const mixed = (await signIn(idp)).claims;
      assert.equal(mixed.email_verified, false);
      assert.equal(mixed.xms_edov, true);
    });

    test("the protocol claims cannot be overridden this way: the token faults are the only way to bend them", async () => {
      idp.signInAs({ ...alpha, claims: { iss: "https://elsewhere.example", aud: "x", exp: 1, nonce: "x", sub: "x" } });
      const { tokens, attempt: a } = await signIn(idp);
      const claims = await verify(idp, tokens.id_token);
      assert.equal(claims.sub, alpha.sub);
      assert.equal(claims.nonce, a.nonce);
    });
  });

  test("FAULTS lists every fault, and each one runs", async () => {
    const expected: Fault[] = [
      "no_email",
      "email_unverified",
      "no_verified_claim",
      "wrong_issuer",
      "wrong_audience",
      "expired",
      "wrong_key",
      "wrong_nonce",
      "wrong_state",
      "cancelled",
      "provider_error",
    ];
    assert.deepEqual([...FAULTS].sort(), [...expected].sort());
    const d = await discover(idp);
    for (const fault of FAULTS) {
      idp.signInAs(alpha, fault);
      const cb = await callbackOf(attempt(d));
      assert.ok(cb.searchParams.get("code") ?? cb.searchParams.get("error"), fault);
    }
  });
});
