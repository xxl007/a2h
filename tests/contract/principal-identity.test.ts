// Contract tests against a live stage for
// openspec/changes/m1-hosted-connector/specs/platform/principal-identity/spec.md:
// what the stage's authorization server does for a client without a browser
// (metadata, registration, PKCE, metadata-document clients, the token's
// claims). The scenarios that need a person (sign-in, consent, revoke,
// refresh after consent) run in Playwright: tests/e2e/sign-in.spec.ts and
// apps/web/test/e2e (same verify job); they are listed here as skipped so
// the suite names every scenario. Registers one dynamic client a run
// (Better Auth allows five a minute per address).
// Run: A2H_MCP_URL=… A2H_WEB_URL=… A2H_TOKEN=… pnpm --filter @a2h/tests contract
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bearerToken, expectedStage, issuer, mcpUrl, webUrl } from "../src/live-env.ts";
import { authorizeUrl, claimsOf, cimdClientId, LOOPBACK_REDIRECT, parseCallback, pkce, registerClient, scopesOf, verifyAccessToken } from "../lib/oauth-client.ts";

const MCP_URL = mcpUrl();
const STAGE = expectedStage(MCP_URL);
const WEB = await webUrl(STAGE);
const ISSUER = await issuer(STAGE);
const RESOURCE = MCP_URL.href.replace(/\/$/, "");
const HTTPS = WEB.startsWith("https://");
const BROWSER = "needs a person: tests/e2e/sign-in.spec.ts and apps/web/test/e2e (Playwright, same verify job)";
// The local stage's test authorization server publishes keys only (no RFC 8414 document, no registration):
// these scenarios run against a deployed stage or a local `next start` of apps/web.
const TEST_ISSUER = process.env["A2H_ISSUER"] ? "A2H_ISSUER names the local stage's test authorization server, which publishes keys only; runs against a deployed stage or a local next start" : false;


/**
 * GET as a browser would (Accept text/html), without following redirects. Better
 * Auth answers a request it takes for a non-browser with `200 {"redirect":true,"url"}`
 * instead of a 302; both forms are read as "redirected to url".
 */
async function authorize(url: string): Promise<{ status: number; location: URL | undefined; body: string }> {
  const res = await fetch(url, {
    redirect: "manual",
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "user-agent": "Mozilla/5.0 (A2H QA contract tests)" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  const loc = res.headers.get("location");
  if (loc) return { status: res.status, location: new URL(loc, url), body };
  if (res.status === 200) {
    try {
      const json = JSON.parse(body) as { redirect?: boolean; url?: string };
      if (json.redirect && json.url) return { status: 302, location: new URL(json.url, url), body };
    } catch {
      /* not JSON: a page */
    }
  }
  return { status: res.status, location: undefined, body };
}

/** The error the server redirected to (its own error page or the client's redirect), or the JSON error of a 400. */
function errorOf(r: { status: number; location: URL | undefined; body: string }): string | undefined {
  if (r.location) return parseCallback(r.location).error;
  if (r.status >= 400) {
    try {
      return (JSON.parse(r.body) as { error?: string }).error;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

describe("Requirement: Sign-in by magic link to an allow-listed address", () => {
  test("Scenario: Allow-listed address", { skip: BROWSER }, () => {});
  test("Scenario: Unknown address", { skip: BROWSER }, () => {});
  test("Scenario: Expired or reused link", { skip: BROWSER }, () => {});
  test("the HTTP endpoint for asking a link is closed: only the sign-in page's action asks, allow-list first", { skip: TEST_ISSUER }, async () => {
    const res = await fetch(`${ISSUER}/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "qa-stranger@a2h-protocol.org", callbackURL: "/" }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(res.status, 404, `POST ${ISSUER}/sign-in/magic-link -> ${res.status}`);
  });
});

describe("Requirement: Magic links leave production only through email", () => {
  test("Scenario: Preview sign-in", { skip: `${BROWSER}; the sink is read with the deploy role (tests/lib/mail-sink.ts)` }, () => {});
});

describe("Requirement: Consent names the client and the scopes", () => {
  test("Scenario: Consent accepted", { skip: BROWSER }, () => {});
  test("Scenario: Consent declined", { skip: BROWSER }, () => {});
});

describe("Requirement: Clients register by metadata document, dynamic registration or pre-registration", { skip: TEST_ISSUER }, () => {
  test("the authorization server metadata advertises CIMD, `none`, S256 only and the iss parameter; the JWKS holds public keys only", async () => {
    const as = new URL(ISSUER);
    const res = await fetch(`${as.origin}/.well-known/oauth-authorization-server${as.pathname}`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as Record<string, unknown>;
    assert.equal(doc["issuer"], ISSUER);
    assert.equal(doc["client_id_metadata_document_supported"], true);
    assert.ok((doc["token_endpoint_auth_methods_supported"] as string[]).includes("none"));
    assert.deepEqual(doc["code_challenge_methods_supported"], ["S256"]);
    assert.equal(doc["authorization_response_iss_parameter_supported"], true);
    assert.equal(doc["registration_endpoint"], `${ISSUER}/oauth2/register`);
    assert.equal(doc["jwks_uri"], `${ISSUER}/jwks`);
    assert.ok((doc["scopes_supported"] as string[]).includes("a2h"));
    const jwks = (await (await fetch(`${ISSUER}/jwks`, { signal: AbortSignal.timeout(15_000) })).json()) as { keys: Record<string, unknown>[] };
    assert.ok(jwks.keys.length > 0);
    for (const k of jwks.keys) {
      assert.equal(k["d"], undefined, "a private key component in the JWKS");
      assert.ok(typeof k["kid"] === "string" && k["kid"], "every key has a kid");
    }
    // OAuth-only (design D8): no OpenID configuration.
    assert.equal((await fetch(`${as.origin}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) })).status, 404);
  });

  let dynamicClient = "";

  test("Scenario: Dynamic registration: a client_id, no secret, native by default", async () => {
    const reg = await registerClient(ISSUER, `A2H QA contract ${Date.now()}`);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    dynamicClient = String(reg.body["client_id"]);
    assert.ok(dynamicClient);
    assert.equal(reg.body["client_secret"], undefined, "a public client gets no secret");
    assert.equal(reg.body["application_type"], "native");
    assert.deepEqual(reg.body["redirect_uris"], [LOOPBACK_REDIRECT]);
  });

  test("Scenario: PKCE missing (or a method other than S256): invalid_request before any consent screen", async () => {
    assert.ok(dynamicClient, "needs the dynamic client of the previous test");
    const missing = await authorize(authorizeUrl(ISSUER, { clientId: dynamicClient, resource: RESOURCE }));
    assert.ok(!missing.location?.pathname.startsWith("/consent") && !missing.location?.pathname.startsWith("/sign-in"), `missing PKCE reached ${missing.location?.href}`);
    assert.equal(errorOf(missing), "invalid_request", `missing PKCE: ${missing.status} ${missing.location?.href ?? missing.body.slice(0, 200)}`);
    const plain = await authorize(authorizeUrl(ISSUER, { clientId: dynamicClient, resource: RESOURCE, challenge: "plain-value", challengeMethod: "plain" }));
    assert.equal(errorOf(plain), "invalid_request", `plain: ${plain.status} ${plain.location?.href ?? plain.body.slice(0, 200)}`);
  });

  test("a well-formed request for a registered client leads to sign-in (no session here), never to consent", async () => {
    assert.ok(dynamicClient, "needs the dynamic client");
    const r = await authorize(authorizeUrl(ISSUER, { clientId: dynamicClient, resource: RESOURCE, challenge: pkce().challenge }));
    assert.equal(r.status, 302, `${r.status} ${r.body.slice(0, 200)}`);
    assert.equal(errorOf(r), undefined, `refused: ${r.location?.href}`);
    assert.equal(r.location?.pathname, "/sign-in", `redirected to ${r.location?.href}`);
  });

  test("Scenario: Metadata-document client: the preview's own document is accepted; a client_id mismatch and a redirect outside the document are refused", { skip: HTTPS ? false : "a CIMD client_id must be an https URL on a public host" }, async () => {
    const match = await authorize(authorizeUrl(ISSUER, { clientId: cimdClientId(WEB), resource: RESOURCE, challenge: pkce().challenge }));
    assert.equal(errorOf(match), undefined, `match.json refused: ${match.status} ${match.location?.href ?? match.body.slice(0, 200)}`);
    assert.equal(match.location?.pathname, "/sign-in", `match.json led to ${match.location?.href}`);
    const mismatch = await authorize(authorizeUrl(ISSUER, { clientId: cimdClientId(WEB, "mismatch.json"), resource: RESOURCE, challenge: pkce().challenge }));
    assert.equal(mismatch.status, 400, `mismatch.json: ${mismatch.status}`);
    assert.equal(errorOf(mismatch), "invalid_client");
    const stolen = await authorize(authorizeUrl(ISSUER, { clientId: cimdClientId(WEB), resource: RESOURCE, challenge: pkce().challenge, redirect: "https://attacker.example/cb" }));
    assert.notEqual(stolen.location?.host, "attacker.example", "the code must never go to a redirect the document does not name");
    assert.ok(errorOf(stolen) !== undefined || stolen.status >= 400, `a redirect outside the document was not refused: ${stolen.status} ${stolen.location?.href}`);
  });

  test("Scenario: Metadata document from a private address: refused, never fetched", async () => {
    // Distinct addresses: the CIMD fetcher keys its minimum fetch interval per client, and localhost is 127.0.0.1.
    for (const id of ["https://127.0.0.1/client.json", "https://169.254.169.254/latest/meta-data/client.json", "https://10.0.0.1/client.json", "https://[::1]/client.json"]) {
      const r = await authorize(authorizeUrl(ISSUER, { clientId: id, resource: RESOURCE, challenge: pkce().challenge }));
      assert.ok(!r.location?.pathname.startsWith("/consent"), `${id} reached consent`);
      assert.equal(errorOf(r), "invalid_client", `${id}: ${r.status} ${r.location?.href ?? r.body.slice(0, 200)}`);
    }
  });
});

describe("Requirement: Tokens are short-lived, audience-bound and refreshable", () => {
  test("Scenario: Resource recorded as audience: the signed-in principal's token verifies against the stage's JWKS, aud is exactly the MCP URL, lifetime one hour or less", { skip: bearerToken() ? false : "needs A2H_TOKEN" }, async () => {
    const token = bearerToken()!;
    const claims = await verifyAccessToken(ISSUER, token, RESOURCE);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    assert.deepEqual(aud, [RESOURCE], "audience is exactly the stage's MCP URL");
    assert.equal(claims.iss, ISSUER);
    assert.ok(typeof claims.sub === "string" && claims.sub.length > 0, "a subject (the principal id)");
    assert.ok(claims.exp! - claims.iat! <= 3600, `lifetime ${claims.exp! - claims.iat!} s`);
    assert.ok(scopesOf(claims).includes("a2h"));
    // Nothing personal in the token the client holds: no email, no name.
    const decoded = claimsOf(token) as Record<string, unknown>;
    for (const k of ["email", "name", "given_name", "family_name", "preferred_username"]) assert.equal(decoded[k], undefined, `claim ${k} present`);
  });

  test("Scenario: Refresh token replayed", { skip: `${BROWSER} (apps/web/test/e2e/consent.spec.ts)` }, () => {});
});

describe("Requirement: Sign-out revokes", () => {
  test("Scenario: Client revoked", { skip: `${BROWSER} (apps/web/test/e2e/consent.spec.ts)` }, () => {});
});
