// Design D10, spec principal-identity "Unknown address" (nothing about the
// address is logged): no log line carries an address, a token or a query.
import { describe, expect, test } from "vitest";
import { betterAuthLog, createLogger, redact } from "../src/log";

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ write: (l) => lines.push(l), level: "debug", now: () => new Date(0) });
  return { lines, logger };
}

describe("redact", () => {
  test("removes email addresses", () => {
    expect(redact("magic link for Alice.Smith+x@Example.co.uk sent")).toBe("magic link for [address] sent");
  });
  test("removes query strings", () => {
    expect(redact("GET /api/auth/magic-link/verify?token=abc&callbackURL=%2F")).toBe("GET /api/auth/magic-link/verify?[query]");
  });
  test("removes JWTs and long tokens", () => {
    expect(redact("token eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln")).toBe("token [token]");
    expect(redact("refresh Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4")).toBe("refresh [token]");
  });
});

describe("createLogger", () => {
  test("writes one JSON line with the allowed fields only", () => {
    const { lines, logger } = capture();
    logger.info("consent accepted", { principal_id: "u1", client_id: "c1", code: "consent_accepted", ...({ email: "a@b.example" } as object) });
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toEqual({ level: "info", time: "1970-01-01T00:00:00.000Z", msg: "consent accepted", principal_id: "u1", client_id: "c1", code: "consent_accepted" });
  });

  test("Better Auth messages and their arguments never put an address in a line", () => {
    const { lines, logger } = capture();
    const log = betterAuthLog(logger);
    log("error", "Failed to send magic link to someone@example.org", { email: "someone@example.org" }, new TypeError("x someone@example.org"));
    log("info", "user someone@example.org signed in");
    expect(lines.join("\n")).not.toMatch(/@/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "error", code: "TypeError" });
  });

  test("respects the level", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (l) => lines.push(l), level: "warn" });
    logger.info("x");
    logger.warn("y");
    expect(lines).toHaveLength(1);
  });
});
