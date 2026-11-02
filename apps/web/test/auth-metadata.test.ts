// Task 5.2 (design D1, D8; spec principal-identity "Clients register by…",
// metadata part): what the authorization server publishes.
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { BASE, ISSUER, metadataHandlers, startHarness, type Harness } from "./lib/auth-harness";

const adminUrl = inject("pgAdminUrl");

describe.skipIf(!adminUrl)("authorization server metadata", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness(adminUrl, "pr_52");
  });
  afterAll(async () => {
    await h?.close();
  });

  test("RFC 8414 document at /.well-known/oauth-authorization-server/api/auth", async () => {
    const res = await metadataHandlers(h.auth).oauth(new Request(`${BASE}/.well-known/oauth-authorization-server/api/auth`));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc["issuer"]).toBe(ISSUER);
    expect(doc["authorization_endpoint"]).toBe(`${ISSUER}/oauth2/authorize`);
    expect(doc["token_endpoint"]).toBe(`${ISSUER}/oauth2/token`);
    expect(doc["registration_endpoint"]).toBe(`${ISSUER}/oauth2/register`);
    expect(doc["jwks_uri"]).toBe(`${ISSUER}/jwks`);
    expect(doc["client_id_metadata_document_supported"]).toBe(true);
    expect(doc["token_endpoint_auth_methods_supported"]).toContain("none");
    expect(doc["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(doc["authorization_response_iss_parameter_supported"]).toBe(true);
    expect(doc["scopes_supported"]).toEqual(["a2h", "offline_access"]);
    expect(doc["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);
  });

  test("OIDC discovery: not served, because the server is OAuth-only (no openid scope, D1)", async () => {
    // Better Auth refuses it (404) when `openid` is not a scope; apps/web has no route for it either.
    await expect(metadataHandlers(h.auth).openid(new Request(`${ISSUER}/.well-known/openid-configuration`))).rejects.toMatchObject({ statusCode: 404 });
  });

  test("JWKS at /api/auth/jwks: one Ed25519 public key, no private part", async () => {
    const res = await h.auth.handler(new Request(`${ISSUER}/jwks`));
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    expect(keys[0]!["d"]).toBeUndefined();
  });
});
