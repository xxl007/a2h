// Task 5.5 in-process: spec principal-identity "Clients register by metadata
// document, dynamic registration or pre-registration" (the dynamic and PKCE
// scenarios are in oauth-flow.test.ts). The CIMD transport is stubbed here;
// the real Node transport's refusal of private addresses is tested at the end,
// and the whole path runs against the preview in test/e2e/clients.spec.ts.
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { oauthClient, eq } from "@a2h/db";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { syncPreRegisteredClients } from "../src/auth/clients";
import { readConsentRequest } from "../src/auth/consent";
import { authorizeUrlFromLoginQuery, requestMagicLink } from "../src/auth/sign-in";
import { ALLOWED, BASE, Browser, MCP, SECRET, authorizePath, pkce, startHarness, type Harness } from "./lib/auth-harness";

const adminUrl = inject("pgAdminUrl");
const DOC_URL = "https://cimd.client.example/oauth/client.json";
const REDIRECT = "http://127.0.0.1:43110/callback";

describe.skipIf(!adminUrl)("Requirement: Clients register by metadata document, dynamic registration or pre-registration", () => {
  let h: Harness;
  let browser: Browser;

  beforeAll(async () => {
    h = await startHarness(adminUrl, "pr_56");
    browser = new Browser(h.auth);
    // Sign the browser in once (any client's authorize leads through the same login).
    await requestMagicLink({ auth: h.auth, isAllowed: h.isAllowed, logger: h.logger }, { email: ALLOWED, next: undefined, headers: new Headers({ origin: BASE }) });
    const res = await browser.request(h.mail.at(-1)!.url);
    expect(res.status).toBe(302);
  });
  afterAll(async () => {
    await h?.close();
  });

  function params(clientId: string, redirect = REDIRECT) {
    return {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      scope: "a2h offline_access",
      state: "s",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: MCP,
    };
  }

  async function authorize(clientId: string, redirect = REDIRECT): Promise<URL> {
    const res = await browser.request(authorizePath(params(clientId, redirect)));
    return new URL(res.headers.get("location") ?? `${BASE}/no-redirect?status=${res.status}`, BASE);
  }

  test("Scenario: Metadata-document client: proceeds with the document's name on the consent screen; the document is cached", async () => {
    h.cimd.set(DOC_URL, { client_id: DOC_URL, client_name: "Example Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    const to = await authorize(DOC_URL);
    expect(to.pathname).toBe("/consent");
    const request = await readConsentRequest(h.db, SECRET, to.searchParams);
    expect(request).toMatchObject({ state: "ready", client: { id: DOC_URL, name: "Example Agent", origin: "cimd.client.example", registration: "metadata-document" } });
    const [row] = await h.db.select().from(oauthClient).where(eq(oauthClient.clientId, DOC_URL));
    expect(row!.clientDiscoveryId).toBeTruthy();
    // Cached: the document is not fetched again on the next authorization.
    h.cimd.delete(DOC_URL);
    expect((await authorize(DOC_URL)).pathname).toBe("/consent");
  });

  test("a document whose client_id differs from its URL is refused", async () => {
    const url = "https://cimd.client.example/oauth/mismatch.json";
    h.cimd.set(url, { client_id: "https://other.example/client.json", client_name: "Mismatch", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const to = await authorize(url);
    expect(to.pathname).not.toBe("/consent");
    // Refused at the authorization server: an error page or a 400, never a redirect to the client.
    expect(to.origin).toBe(BASE);
    expect(to.searchParams.get("error") ?? to.searchParams.get("status")).toBeTruthy();
    expect(await h.db.select().from(oauthClient).where(eq(oauthClient.clientId, url))).toHaveLength(0);
  });

  test("a redirect URI not in the document is refused, and nothing is sent to it", async () => {
    const url = "https://cimd.client.example/oauth/other-redirect.json";
    h.cimd.set(url, { client_id: url, client_name: "Other redirect", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const to = await authorize(url, "https://attacker.example/cb");
    expect(to.pathname).not.toBe("/consent");
    expect(to.host).not.toBe("attacker.example");
  });

  test("Scenario: Metadata document from a private address: not fetched, client refused", async () => {
    for (const url of ["https://127.0.0.1/client.json", "https://localhost/client.json", "https://10.0.0.8/client.json", "https://169.254.169.254/latest/meta-data/client.json", "https://[::1]/client.json"]) {
      h.cimd.set(url, { client_id: url, client_name: "Private", redirect_uris: [REDIRECT] });
      const fetches = h.cimdFetches.length;
      const to = await authorize(url);
      expect(to.pathname, url).not.toBe("/consent");
      expect(h.cimdFetches.length, url).toBe(fetches);
      expect(await h.db.select().from(oauthClient).where(eq(oauthClient.clientId, url))).toHaveLength(0);
    }
  });

  test("the Node transport refuses a public name that resolves to a loopback address (resolve-once, pinned)", async () => {
    // localtest.me and its subdomains resolve to 127.0.0.1 in public DNS.
    await expect(Promise.resolve().then(() => fetchClientMetadataResource("https://cimd.localtest.me/client.json"))).rejects.toThrow();
  });

  test("Pre-registered client: created from configuration, named as registered by the A2H team", async () => {
    await syncPreRegisteredClients(h.db, h.auth, [{ client_id: "a2h-test-host", client_name: "Test Host", redirect_uris: ["https://host.example/oauth/callback"] }], MCP);
    // Idempotent.
    await syncPreRegisteredClients(h.db, h.auth, [{ client_id: "a2h-test-host", client_name: "Test Host", redirect_uris: ["https://host.example/oauth/callback"] }], MCP);
    expect(await h.db.select().from(oauthClient).where(eq(oauthClient.clientId, "a2h-test-host"))).toHaveLength(1);
    const to = await authorize("a2h-test-host", "https://host.example/oauth/callback");
    expect(to.pathname).toBe("/consent");
    const request = await readConsentRequest(h.db, SECRET, to.searchParams);
    expect(request).toMatchObject({ state: "ready", client: { name: "Test Host", origin: "host.example", registration: "pre-registered" }, returnOrigin: "host.example" });
  });

  test("the login redirect keeps the whole request for after sign-in", async () => {
    const anon = new Browser(h.auth);
    h.cimd.set(DOC_URL, { client_id: DOC_URL, client_name: "Example Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const res = await anon.request(authorizePath(params(DOC_URL)));
    const login = new URL(res.headers.get("location")!, BASE);
    expect(login.pathname).toBe("/sign-in");
    const next = new URL(authorizeUrlFromLoginQuery(login.searchParams)!, BASE);
    expect(next.searchParams.get("client_id")).toBe(DOC_URL);
    expect(next.searchParams.get("resource")).toBe(MCP);
    expect(next.searchParams.get("code_challenge_method")).toBe("S256");
    expect(next.searchParams.get("sig")).toBeNull();
  });
});
