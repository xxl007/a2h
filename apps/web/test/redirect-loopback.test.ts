// Spec principal-identity "Clients register by metadata document, dynamic
// registration or pre-registration", RFC 8252 §7.3: a native client's
// loopback redirect (`http://127.0.0.1:<port>/…`, `http://[::1]:<port>/…`)
// is accepted by the authorization endpoint of a deployed stage, the same
// as `http://localhost:<port>/…`. QA found 127.0.0.1 refused with
// `invalid_redirect` on preview stages while a local `next start` accepted
// it: the route handler receives a NextRequest, whose `url` is Next's
// normalised form, where the first loopback literal anywhere in the URL
// becomes `localhost`; on localhost:3000 that first literal is the host
// itself, on a stage host it is the `redirect_uri`. These tests drive the
// route handler with NextRequests on a stage host.
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { authRouteHandler } from "../src/server/auth-route";
import { authorizePath, pkce, registerDynamic, startHarness, type Harness } from "./lib/auth-harness";

const adminUrl = inject("pgAdminUrl");
const STAGE = "https://pr-59.example.test";
const STAGE_MCP = "https://mcp.example.test/pr-59/mcp";

describe.skipIf(!adminUrl)("loopback redirect URIs through the route handler on a stage host (RFC 8252 §7.3)", () => {
  let h: Harness;
  let handle: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    h = await startHarness(adminUrl, "pr_59_redirect", undefined, { baseURL: STAGE, mcpUrl: STAGE_MCP });
    handle = authRouteHandler(() => Promise.resolve(h.auth));
  });
  afterAll(async () => {
    await h?.close();
  });

  async function register(redirectUris: string[]): Promise<string> {
    const res = await registerDynamic(
      h.auth,
      {
        client_name: "Native test client",
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      STAGE,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }

  /** The authorize request as the Lambda receives it: a NextRequest on the stage's host, redirect_uri as the client wrote it. */
  function authorizeRequest(clientId: string, redirectUri: string): NextRequest {
    const path = authorizePath({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "a2h offline_access",
      state: "st-1",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: STAGE_MCP,
    }).replace(encodeURIComponent(redirectUri), redirectUri);
    return new NextRequest(`${STAGE}${path}`, { headers: { origin: STAGE } });
  }

  async function authorize(clientId: string, redirectUri: string): Promise<URL> {
    const res = await handle(authorizeRequest(clientId, redirectUri));
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location")!, STAGE);
  }

  test("a native client registered with http://127.0.0.1:<port>/callback is sent to sign-in with that redirect_uri", async () => {
    const id = await register(["http://127.0.0.1:43110/callback"]);
    const next = await authorize(id, "http://127.0.0.1:43110/callback");
    expect(next.pathname, next.toString()).toBe("/sign-in");
    expect(next.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:43110/callback");
  });

  test("the loopback port may differ from the registered one (RFC 8252 §7.3)", async () => {
    const id = await register(["http://127.0.0.1:43110/callback"]);
    const next = await authorize(id, "http://127.0.0.1:51234/callback");
    expect(next.pathname, next.toString()).toBe("/sign-in");
  });

  test("a native client registered with http://[::1]:<port>/callback is sent to sign-in with that redirect_uri", async () => {
    const id = await register(["http://[::1]:43110/callback"]);
    const next = await authorize(id, "http://[::1]:43110/callback");
    expect(next.pathname, next.toString()).toBe("/sign-in");
    expect(next.searchParams.get("redirect_uri")).toBe("http://[::1]:43110/callback");
  });

  test("http://localhost:<port>/callback keeps working", async () => {
    const id = await register(["http://localhost:43110/callback"]);
    const next = await authorize(id, "http://localhost:43110/callback");
    expect(next.pathname, next.toString()).toBe("/sign-in");
  });

  test("a non-loopback http redirect is refused at registration and at authorize", async () => {
    const res = await registerDynamic(
      h.auth,
      { client_name: "Bad", redirect_uris: ["http://attacker.example/callback"], token_endpoint_auth_method: "none", response_types: ["code"], grant_types: ["authorization_code"] },
      STAGE,
    );
    expect(res.status).toBe(400);
    const id = await register(["http://127.0.0.1:43110/callback"]);
    const next = await authorize(id, "http://attacker.example/callback");
    expect(next.pathname).toBe("/api/auth/error");
    // Better Auth refuses plain http off loopback before matching (`invalid_request`); never a redirect to it.
    expect(["invalid_request", "invalid_redirect"]).toContain(next.searchParams.get("error"));
  });

  test("an unregistered path on the loopback host is refused", async () => {
    const id = await register(["http://127.0.0.1:43110/callback"]);
    const next = await authorize(id, "http://127.0.0.1:43110/other");
    expect(next.pathname).toBe("/api/auth/error");
    expect(next.searchParams.get("error")).toBe("invalid_redirect");
  });

  test("why: Better Auth given the NextRequest itself sees localhost and refuses (the Next.js behaviour this handler works around)", async () => {
    const id = await register(["http://127.0.0.1:43110/callback"]);
    const res = await h.auth.handler(authorizeRequest(id, "http://127.0.0.1:43110/callback"));
    const next = new URL(res.headers.get("location")!, STAGE);
    // When this fails after a Next.js upgrade, Next stopped rewriting loopback literals and the workaround can go.
    expect(next.searchParams.get("error")).toBe("invalid_redirect");
  });
});
