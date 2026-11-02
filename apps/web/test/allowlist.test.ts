// Design D7: the allow-list is read at cold start and refreshed every five
// minutes; addresses compare case-insensitively; a failed refresh keeps the
// last good list and never logs an address.
import { describe, expect, test } from "vitest";
import { Allowlist, parseAllowlist } from "../src/auth/allowlist";
import { createLogger } from "../src/log";

describe("parseAllowlist", () => {
  test("splits on commas, whitespace and newlines, lower-cases and drops blanks", () => {
    expect([...parseAllowlist(" Alice@Example.com, bob@example.org\n\ncarol@x.example ,")]).toEqual([
      "alice@example.com",
      "bob@example.org",
      "carol@x.example",
    ]);
  });
  test("an empty value is an empty list", () => {
    expect(parseAllowlist("").size).toBe(0);
    expect(parseAllowlist("none").size).toBe(0);
  });
});

describe("Allowlist", () => {
  test("loads once, then again only after five minutes", async () => {
    let t = 0;
    let calls = 0;
    let value = "a@example.com";
    const list = new Allowlist(() => {
      calls++;
      return Promise.resolve(value);
    }, { now: () => t });
    expect(await list.has("A@example.com")).toBe(true);
    expect(await list.has("b@example.com")).toBe(false);
    expect(calls).toBe(1);
    value = "b@example.com";
    t = 4 * 60_000;
    expect(await list.has("b@example.com")).toBe(false);
    t = 5 * 60_000 + 1;
    expect(await list.has("b@example.com")).toBe(true);
    expect(await list.has("a@example.com")).toBe(false);
    expect(calls).toBe(2);
  });

  test("a failed refresh keeps the last good list and logs no address", async () => {
    let t = 0;
    let fail = false;
    const lines: string[] = [];
    const list = new Allowlist(() => {
      if (fail) return Promise.reject(new Error("ssm down for a@example.com"));
      return Promise.resolve("a@example.com");
    }, { now: () => t, logger: createLogger({ write: (l) => lines.push(l) }) });
    expect(await list.has("a@example.com")).toBe(true);
    fail = true;
    t = 10 * 60_000;
    expect(await list.has("a@example.com")).toBe(true);
    expect(lines.join("\n")).toContain("allowlist_refresh_failed");
    expect(lines.join("\n")).not.toContain("@");
  });

  test("no list ever loaded: nobody is allowed", async () => {
    const list = new Allowlist(() => Promise.reject(new Error("x")), { logger: createLogger({ write: () => undefined }) });
    expect(await list.has("a@example.com")).toBe(false);
  });

  test("concurrent callers share one load", async () => {
    let calls = 0;
    const list = new Allowlist(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return "a@example.com";
    });
    await Promise.all([list.has("a@example.com"), list.has("a@example.com"), list.has("x@example.com")]);
    expect(calls).toBe(1);
  });
});
