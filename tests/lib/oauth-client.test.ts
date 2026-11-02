// The pure parts of tests/lib/oauth-client.ts (task 8.3): PKCE S256, the
// authorize URL, the preview's metadata-document client id, the callback
// parser, scope reading and the masked $GITHUB_ENV lines.
// Run: pnpm --filter @a2h/tests test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ALL_SCOPES, authorizeUrl, cimdClientId, githubEnvLines, LOOPBACK_REDIRECT, parseCallback, pkce, scopesOf } from "./oauth-client.ts";

test("pkce: a 43-character base64url verifier and its S256 challenge", () => {
  const fixed = pkce(() => Uint8Array.from({ length: 32 }, (_, i) => i));
  assert.equal(fixed.verifier, Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i)).toString("base64url"));
  assert.equal(fixed.challenge, createHash("sha256").update(fixed.verifier).digest("base64url"));
  const a = pkce();
  const b = pkce();
  assert.notEqual(a.verifier, b.verifier, "fresh randomness each time");
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/);
});

test("authorizeUrl: code flow, loopback redirect, both scopes, resource and S256 by default; PKCE left out on request", () => {
  const u = new URL(authorizeUrl("https://pr-51.dev.a2h-protocol.org/api/auth", { clientId: "c1", resource: "https://mcp.dev.a2h-protocol.org/pr-51/mcp", challenge: "ch" }));
  assert.equal(u.origin + u.pathname, "https://pr-51.dev.a2h-protocol.org/api/auth/oauth2/authorize");
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    response_type: "code",
    client_id: "c1",
    redirect_uri: LOOPBACK_REDIRECT,
    scope: ALL_SCOPES,
    state: "a2h-tests",
    resource: "https://mcp.dev.a2h-protocol.org/pr-51/mcp",
    code_challenge: "ch",
    code_challenge_method: "S256",
  });
  const noPkce = new URL(authorizeUrl("https://x/api/auth", { clientId: "c1", resource: "https://m/mcp" }));
  assert.equal(noPkce.searchParams.has("code_challenge"), false);
  assert.equal(noPkce.searchParams.has("code_challenge_method"), false);
  const plain = new URL(authorizeUrl("https://x/api/auth", { clientId: "c1", resource: "https://m/mcp", challenge: "v", challengeMethod: "plain", scope: "offline_access" }));
  assert.equal(plain.searchParams.get("code_challenge_method"), "plain");
  assert.equal(plain.searchParams.get("scope"), "offline_access");
});

test("the loopback redirect is the one the preview's metadata documents name; cimdClientId points at the preview's own document", () => {
  assert.equal(LOOPBACK_REDIRECT, "http://127.0.0.1:43110/callback");
  assert.equal(cimdClientId("https://pr-51.dev.a2h-protocol.org/"), "https://pr-51.dev.a2h-protocol.org/test-fixtures/cimd/match.json");
  assert.equal(cimdClientId("https://pr-51.dev.a2h-protocol.org", "mismatch.json"), "https://pr-51.dev.a2h-protocol.org/test-fixtures/cimd/mismatch.json");
});

test("parseCallback reads code, state, error and iss; absent ones are left out", () => {
  assert.deepEqual(parseCallback("http://127.0.0.1:43110/callback?code=abc&state=s&iss=https%3A%2F%2Fx%2Fapi%2Fauth"), {
    code: "abc",
    state: "s",
    iss: "https://x/api/auth",
  });
  assert.deepEqual(parseCallback(new URL("http://127.0.0.1:43110/callback?error=access_denied&error_description=no&state=s")), {
    state: "s",
    error: "access_denied",
    errorDescription: "no",
  });
});

test("scopesOf reads `scope` (space-separated) or `scp` (array)", () => {
  assert.deepEqual(scopesOf({ scope: "a2h offline_access" }), ["a2h", "offline_access"]);
  assert.deepEqual(scopesOf({ scp: ["a2h"] }), ["a2h"]);
  assert.deepEqual(scopesOf({}), []);
});

test("githubEnvLines masks every value before naming it, one line each, and refuses names or values that would break the file", () => {
  const { masks, env } = githubEnvLines({ A2H_TOKEN: "eyJ.a.b", A2H_TOKEN_2: "eyJ.c.d" });
  assert.deepEqual(masks, ["::add-mask::eyJ.a.b", "::add-mask::eyJ.c.d"]);
  assert.equal(env, "A2H_TOKEN=eyJ.a.b\nA2H_TOKEN_2=eyJ.c.d\n");
  assert.throws(() => githubEnvLines({ "bad-name": "x" }), /not an environment name/);
  assert.throws(() => githubEnvLines({ A2H_TOKEN: "two\nlines" }), /one line/);
});
