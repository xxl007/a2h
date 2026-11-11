// The approval test helper's request ids: valid by the protocol's pattern and
// never repeated, so `awaiting()` cannot hit RequestIdTaken in a test database.
import { describe, expect, it } from "vitest";
import { REQUEST_ID_PATTERN } from "@a2h/protocol";
import { nextRequestId, REQUEST_ID_CAPACITY } from "./lib/approval-db";

describe("approval test helper request ids", () => {
  it("are valid, distinct for the whole range, and refuse to wrap", () => {
    const seen = new Set<string>();
    for (let i = 0; i < REQUEST_ID_CAPACITY; i++) {
      const id = nextRequestId();
      expect(id).toMatch(REQUEST_ID_PATTERN);
      seen.add(id);
    }
    expect(seen.size).toBe(REQUEST_ID_CAPACITY);
    // approval-page.test.ts uses A2H-ffff as the id that never exists.
    expect(seen.has("A2H-ffff")).toBe(false);
    expect(() => nextRequestId()).toThrow(/ran out/);
  });
});
