// m2-approval-page task 5.1, spec platform/approval-page "Signed out" and
// design.md A12: the approval token never travels in `next`, the sign-in
// URL or the magic-link email. A hit on /approve/{id}?t=… keeps the token in
// a short-lived HttpOnly cookie scoped to that page and continues at the
// bare /approve/{id}; only that path is ever a `next`.
import { describe, expect, test } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config } from "../middleware";
import { APPROVAL_COOKIE, APPROVAL_COOKIE_SECONDS, approvalTokenRedirect } from "../src/approval/link";
import { safeNext } from "../src/auth/sign-in";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"; // 43 base64url characters, last one in the allowed set

describe("the token leaves the URL at once", () => {
  test("a link with a token: cookie on /approve/{id} only, then the bare page", () => {
    const r = approvalTokenRedirect(new URL(`https://pr-12.dev.a2h-protocol.org/approve/A2H-7f3c?t=${TOKEN}`));
    expect(r).toEqual({
      location: "https://pr-12.dev.a2h-protocol.org/approve/A2H-7f3c",
      cookie: { name: APPROVAL_COOKIE, value: TOKEN, path: "/approve/A2H-7f3c", httpOnly: true, secure: true, sameSite: "lax", maxAge: APPROVAL_COOKIE_SECONDS },
    });
  });
  test("http only on a local server: the cookie is not Secure there", () => {
    expect(approvalTokenRedirect(new URL(`http://localhost:3210/approve/A2H-7f3c?t=${TOKEN}`))?.cookie.secure).toBe(false);
  });
  test("any other query is dropped with the token", () => {
    expect(approvalTokenRedirect(new URL(`https://x.example/approve/A2H-7f3c?t=${TOKEN}&utm=1`))?.location).toBe("https://x.example/approve/A2H-7f3c");
  });
  test("no token, or a path that is not an approval page: nothing to do", () => {
    expect(approvalTokenRedirect(new URL("https://x.example/approve/A2H-7f3c"))).toBeUndefined();
    expect(approvalTokenRedirect(new URL(`https://x.example/approve/not-an-id?t=${TOKEN}`))).toBeUndefined();
    expect(approvalTokenRedirect(new URL(`https://x.example/approve/A2H-7f3c/x?t=${TOKEN}`))).toBeUndefined();
  });
  test("a malformed token is still taken out of the URL (the page then shows the expired link)", () => {
    const r = approvalTokenRedirect(new URL("https://x.example/approve/A2H-7f3c?t=forged"));
    expect(r?.location).toBe("https://x.example/approve/A2H-7f3c");
    expect(r?.cookie.value).toBe("forged");
  });
  test("the cookie lives at most as long as a link (24 hours)", () => {
    expect(APPROVAL_COOKIE_SECONDS).toBe(24 * 3600);
  });
});

describe("middleware", () => {
  test("runs on approval pages only", () => {
    expect(config.matcher).toEqual(["/approve/:id"]);
  });
  test("303 to the bare page with the cookie set; the response carries no token in its location", () => {
    const res = middleware(new NextRequest(`https://pr-12.dev.a2h-protocol.org/approve/A2H-7f3c?t=${TOKEN}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://pr-12.dev.a2h-protocol.org/approve/A2H-7f3c");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toContain(`${APPROVAL_COOKIE}=${TOKEN}`);
    expect(set).toMatch(/Path=\/approve\/A2H-7f3c/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=lax/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  test("without a token the request goes on", () => {
    const res = middleware(new NextRequest("https://x.example/approve/A2H-7f3c"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("Signed out: sign-in leads back to the approval page, never with a token", () => {
  test("/approve/{id} is a valid next; with any query it is not", () => {
    expect(safeNext("/approve/A2H-7f3c")).toBe("/approve/A2H-7f3c");
    for (const bad of [`/approve/A2H-7f3c?t=${TOKEN}`, "/approve/A2H-7f3c?x=1", "/approve/", "/approve/evil", "/approve/A2H-7f3c/x", "//approve/A2H-7f3c"]) {
      expect(safeNext(bad)).toBeUndefined();
    }
  });
});
