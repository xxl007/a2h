// src/server/auth-route.ts: the request Better Auth gets carries the URL as
// received, not Next's normalised one (loopback literals → `localhost`).
import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { asReceived, receivedUrl } from "../src/server/auth-route";

const STAGE = "https://pr-59.example.test";
const AUTHORIZE = `${STAGE}/api/auth/oauth2/authorize?response_type=code&client_id=c1&redirect_uri=`;

describe("the request handed to Better Auth", () => {
  test("keeps a 127.0.0.1 redirect_uri on a stage host (Next's NextRequest.url says localhost)", () => {
    const next = new NextRequest(`${AUTHORIZE}http://127.0.0.1:43110/callback`);
    expect(receivedUrl(next)).toBe(`${AUTHORIZE}http://127.0.0.1:43110/callback`);
    const given = asReceived(next);
    expect(given.url).toBe(`${AUTHORIZE}http://127.0.0.1:43110/callback`);
    expect(new URL(given.url).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:43110/callback");
  });

  test("keeps an [::1] redirect_uri", () => {
    const given = asReceived(new NextRequest(`${AUTHORIZE}http://[::1]:43110/callback`));
    expect(new URL(given.url).searchParams.get("redirect_uri")).toBe("http://[::1]:43110/callback");
  });

  test("keeps a percent-encoded loopback redirect_uri", () => {
    const encoded = encodeURIComponent("http://127.0.0.1:43110/callback");
    const given = asReceived(new NextRequest(`${AUTHORIZE}${encoded}`));
    expect(given.url).toBe(`${AUTHORIZE}${encoded}`);
  });

  test("keeps the magic link's callbackURL when it carries a loopback redirect_uri", () => {
    const callback = `${STAGE}/api/auth/oauth2/authorize?redirect_uri=http://127.0.0.1:43110/callback`;
    const url = `${STAGE}/api/auth/magic-link/verify?token=t&callbackURL=${encodeURIComponent(callback)}`;
    const given = asReceived(new NextRequest(url));
    expect(new URL(given.url).searchParams.get("callbackURL")).toBe(callback);
  });

  test("a GET keeps method and headers", () => {
    const given = asReceived(new NextRequest(`${AUTHORIZE}http://127.0.0.1:1/cb`, { headers: { cookie: "a=b", origin: STAGE } }));
    expect(given.method).toBe("GET");
    expect(given.headers.get("cookie")).toBe("a=b");
    expect(given.headers.get("origin")).toBe(STAGE);
  });

  test("a POST keeps method, headers and body", async () => {
    const body = JSON.stringify({ redirect_uris: ["http://127.0.0.1:43110/callback"] });
    const next = new NextRequest(`${STAGE}/api/auth/oauth2/register?x=http://127.0.0.1:1/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const given = asReceived(next);
    expect(given.method).toBe("POST");
    expect(given.headers.get("content-type")).toBe("application/json");
    expect(await given.text()).toBe(body);
  });

  test("a request whose URL was not rewritten is handed over as it is", () => {
    const plain = new Request(`${AUTHORIZE}http://127.0.0.1:43110/callback`);
    expect(asReceived(plain)).toBe(plain);
    const local = new NextRequest(`http://localhost:3000/api/auth/oauth2/authorize?redirect_uri=http://127.0.0.1:43110/callback`);
    expect(asReceived(local)).toBe(local);
    expect(local.url).toContain("redirect_uri=http://127.0.0.1:43110/callback");
  });
});
