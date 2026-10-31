// Task 5.3: spec principal-identity "Sign-in by magic link to an
// allow-listed address", its three scenarios in-process (the same scenarios
// run on the preview through the mail sink: test/e2e/sign-in.spec.ts), and
// the helpers the sign-in page uses.
import { session, user, verification } from "@a2h/db";
import { afterAll, beforeAll, describe, expect, inject, test, vi } from "vitest";
import { authorizeUrlFromLoginQuery, checkEmail, requestMagicLink, safeNext } from "../src/auth/sign-in";
import { ALLOWED, BASE, Browser, startHarness, type Harness } from "./lib/auth-harness";

const adminUrl = inject("pgAdminUrl");

describe("checkEmail", () => {
  test("empty, malformed, fine", () => {
    expect(checkEmail("  ")).toEqual({ ok: false, reason: "empty" });
    expect(checkEmail(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(checkEmail("name@")).toEqual({ ok: false, reason: "format" });
    expect(checkEmail(`${"a".repeat(250)}@x.example`)).toEqual({ ok: false, reason: "format" });
    expect(checkEmail(" Name@Example.com ")).toEqual({ ok: true, email: "Name@Example.com" });
  });
});

describe("safeNext and the login query", () => {
  test("keeps an authorize URL or /account/clients, drops anything else", () => {
    expect(safeNext("/api/auth/oauth2/authorize?client_id=x&response_type=code")).toBe("/api/auth/oauth2/authorize?client_id=x&response_type=code");
    expect(safeNext("/account/clients")).toBe("/account/clients");
    for (const bad of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "/consent?x=1", "/api/auth/oauth2/authorize", "/account/clients?x=1", "", null, undefined]) {
      expect(safeNext(bad)).toBeUndefined();
    }
  });
  test("the signed login query becomes the authorize URL without the signature and without prompt=login", () => {
    const q = new URLSearchParams({ response_type: "code", client_id: "c1", scope: "a2h", prompt: "login consent", exp: "1", ba_iat: "2", sig: "s" });
    q.append("ba_param", "client_id");
    expect(authorizeUrlFromLoginQuery(q)).toBe("/api/auth/oauth2/authorize?response_type=code&client_id=c1&scope=a2h&prompt=consent");
    expect(authorizeUrlFromLoginQuery(new URLSearchParams({ foo: "bar" }))).toBeUndefined();
  });
});

describe.skipIf(!adminUrl)("Requirement: Sign-in by magic link to an allow-listed address", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness(adminUrl, "pr_53");
  });
  afterAll(async () => {
    await h?.close();
  });
  const deps = () => ({ auth: h.auth, isAllowed: h.isAllowed, logger: h.logger });
  const headers = () => new Headers({ origin: BASE });
  const count = async (t: typeof user | typeof session | typeof verification) => (await h.db.select().from(t)).length;

  test("Scenario: Allowed address: one link valid at most 15 minutes; following it once signs in and spends it", async () => {
    const before = h.mail.length;
    await requestMagicLink(deps(), { email: ALLOWED, next: undefined, headers: headers() });
    expect(h.mail.length).toBe(before + 1);
    const { email, url } = h.mail.at(-1)!;
    expect(email).toBe(ALLOWED);
    const link = new URL(url);
    expect(`${link.origin}${link.pathname}`).toBe(`${BASE}/api/auth/magic-link/verify`);
    expect(link.searchParams.get("callbackURL")).toBe("/account/clients");
    expect(link.searchParams.get("errorCallbackURL")).toBe("/sign-in/expired");

    const [row] = await h.db.select().from(verification);
    const minutes = (row!.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    // Stored hashed: the token in the link is not in the row.
    expect(row!.identifier).not.toContain(link.searchParams.get("token")!);

    const browser = new Browser(h.auth);
    const res = await browser.request(url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE}/account/clients`);
    expect(browser.cookies.has("better-auth.session_token")).toBe(true);
    expect(await count(session)).toBe(1);

    // Scenario: Expired or reused link: the second use is refused with the resend offer, no session.
    const again = new Browser(h.auth);
    const reuse = await again.request(url);
    expect(reuse.status).toBe(302);
    expect(new URL(reuse.headers.get("location")!).pathname).toBe("/sign-in/expired");
    expect(again.cookies.has("better-auth.session_token")).toBe(false);
    expect(await count(session)).toBe(1);
  });

  test("Scenario: Expired link: refused after 15 minutes, no session", async () => {
    await requestMagicLink(deps(), { email: ALLOWED, next: "/account/clients", headers: headers() });
    const { url } = h.mail.at(-1)!;
    const sessions = await count(session);
    vi.useFakeTimers({ now: Date.now() + 15 * 60_000 + 1_000, toFake: ["Date"] });
    try {
      const b = new Browser(h.auth);
      const res = await b.request(url);
      expect(res.status).toBe(302);
      const to = new URL(res.headers.get("location")!);
      expect(to.pathname).toBe("/sign-in/expired");
      expect(to.searchParams.get("next")).toBe("/account/clients");
      expect(b.cookies.has("better-auth.session_token")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(await count(session)).toBe(sessions);
  });

  test("Scenario: Unknown address: same outcome, no link created, nothing logged about the address", async () => {
    const mails = h.mail.length;
    const rows = await count(verification);
    const users = await count(user);
    const lines = h.logLines.length;
    await expect(requestMagicLink(deps(), { email: "Stranger@Example.org", next: undefined, headers: headers() })).resolves.toBeUndefined();
    expect(h.mail.length).toBe(mails);
    expect(await count(verification)).toBe(rows);
    expect(await count(user)).toBe(users);
    const newLines = h.logLines.slice(lines);
    expect(newLines.join("\n").toLowerCase()).not.toContain("stranger");
    // The allowed path writes the very same line: nothing in the log tells them apart.
    const allowedLines = h.logLines.length;
    await requestMagicLink(deps(), { email: ALLOWED, next: undefined, headers: headers() });
    const strip = (l: string) => JSON.stringify({ ...(JSON.parse(l) as object), time: undefined });
    expect(h.logLines.slice(allowedLines).map(strip)).toEqual(newLines.map(strip));
  });

  test("the HTTP endpoint for asking a link is closed: only the server action (allow-list first) asks", async () => {
    const res = await h.auth.handler(
      new Request(`${BASE}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: "stranger@example.org" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("an address removed from the list after its link was sent cannot sign in", async () => {
    const strict = await startHarness(adminUrl, "pr_54", ALLOWED);
    try {
      await requestMagicLink({ auth: strict.auth, isAllowed: strict.isAllowed, logger: strict.logger }, { email: ALLOWED, next: undefined, headers: headers() });
      const { url } = strict.mail.at(-1)!;
      // Same database, the address is no longer on the list.
      const { createAuth } = await import("../src/auth/auth");
      const closed = createAuth({
        db: strict.db,
        config: { baseURL: BASE, issuer: `${BASE}/api/auth`, mcpUrl: "http://localhost:3001/mcp", secret: "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz" },
        sendMagicLink: () => Promise.resolve(),
        isAllowed: () => Promise.resolve(false),
        logger: strict.logger,
        rateLimit: false,
      });
      const b = new Browser(closed);
      const res = await b.request(url);
      expect(b.cookies.has("better-auth.session_token")).toBe(false);
      expect(res.status).toBe(302);
      expect((await strict.db.select().from(session)).length).toBe(0);
      expect(strict.logLines.join("\n")).not.toContain("@");
    } finally {
      await strict.close();
    }
  });

  test("no log line of the whole run carries an address", () => {
    expect(h.logLines.join("\n")).not.toMatch(/@/);
  });
});
