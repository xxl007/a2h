// Task 5.5 on a stage: spec principal-identity "Clients register by metadata
// document, dynamic registration or pre-registration". The metadata-document
// cases need an https stage (a deployed preview serves its own test documents
// at /test-fixtures/cimd/; src/auth/test-fixtures.ts).
import { expect, test } from "@playwright/test";
import { EMAIL, HTTPS_STAGE, ISSUER, WEB_URL } from "./lib/env";
import { signIn } from "./lib/browser";
import { authorizeUrl, pkce, registerClient } from "./lib/oauth";

test("the authorization server metadata advertises CIMD, public clients, S256 only and iss", async ({ request }) => {
  const res = await request.get(`${WEB_URL}/.well-known/oauth-authorization-server/api/auth`);
  expect(res.status()).toBe(200);
  const doc = (await res.json()) as Record<string, unknown>;
  expect(doc["issuer"]).toBe(ISSUER);
  expect(doc["client_id_metadata_document_supported"]).toBe(true);
  expect(doc["token_endpoint_auth_methods_supported"]).toContain("none");
  expect(doc["code_challenge_methods_supported"]).toEqual(["S256"]);
  expect(doc["authorization_response_iss_parameter_supported"]).toBe(true);
  const jwks = await request.get(`${ISSUER}/jwks`);
  expect(jwks.status()).toBe(200);
  expect(((await jwks.json()) as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
});

// Better Auth allows 5 registrations a minute per address (its default); the
// whole suite registers 3 clients, so leave a minute between two runs.
let dynamicClient = "";

test("Scenario: Dynamic registration: a client_id, no secret", async () => {
  const reg = await registerClient(`E2E dynamic ${Date.now()}`, { application_type: "native" });
  expect(reg.status).toBe(201);
  dynamicClient = reg.body["client_id"] as string;
  expect(dynamicClient).toBeTruthy();
  expect(reg.body["client_secret"]).toBeUndefined();
});

test("Scenario: PKCE missing: invalid_request before any consent screen", async ({ page }) => {
  const clientId = dynamicClient;
  expect(clientId).toBeTruthy();
  await page.goto("/sign-in");
  await signIn(page, EMAIL);
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  await page.route("http://127.0.0.1:43110/**", (route) => route.fulfill({ status: 200, body: "client callback" }));
  await page.goto(authorizeUrl(clientId, undefined)).catch(() => undefined);
  expect(seen.some((u) => u.includes("/consent"))).toBe(false);
  const errorUrl = seen.map((u) => new URL(u)).find((u) => u.searchParams.get("error"));
  expect(errorUrl?.searchParams.get("error")).toBe("invalid_request");
});

test.describe("metadata-document clients", () => {
  test.skip(!HTTPS_STAGE, "needs a deployed https stage serving /test-fixtures/cimd/");

  test("Scenario: Metadata-document client: the document's name on the consent screen", async ({ page }) => {
    await page.goto("/sign-in");
    await signIn(page, EMAIL);
    await page.goto(authorizeUrl(`${WEB_URL}/test-fixtures/cimd/match.json`, pkce().challenge));
    await expect(page).toHaveURL(/\/consent\?/);
    await expect(page.getByRole("heading", { level: 2, name: "A2H test client (metadata document)" })).toBeVisible();
    await expect(page.getByText(`Name published by ${new URL(WEB_URL).hostname}.`)).toBeVisible();
  });

  test("a document whose client_id differs is refused; a redirect not in the document is refused", async ({ page }) => {
    await page.goto("/sign-in");
    await signIn(page, EMAIL);
    const res = await page.goto(authorizeUrl(`${WEB_URL}/test-fixtures/cimd/mismatch.json`, pkce().challenge));
    expect(page.url()).not.toContain("/consent");
    expect(res?.status() === 400 || new URL(page.url()).searchParams.get("error")).toBeTruthy();
    await page.goto(authorizeUrl(`${WEB_URL}/test-fixtures/cimd/match.json`, pkce().challenge, { redirect_uri: "https://attacker.example/cb" }));
    expect(page.url()).not.toContain("/consent");
    expect(new URL(page.url()).host).not.toBe("attacker.example");
  });

  test("Scenario: Metadata document from a private address: refused, nothing fetched", async ({ page }) => {
    await page.goto("/sign-in");
    await signIn(page, EMAIL);
    for (const id of ["https://127.0.0.1/client.json", "https://169.254.169.254/latest/meta-data/client.json", "https://10.0.0.1/client.json"]) {
      await page.goto(authorizeUrl(id, pkce().challenge));
      expect(page.url(), id).not.toContain("/consent");
    }
  });
});
