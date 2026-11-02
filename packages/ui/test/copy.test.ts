import { describe, expect, it } from "vitest";
import { copy, fill } from "../src/screens/copy.js";

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const all = strings(copy);

describe("copy (design.md Screens, skill §6)", () => {
  it("never says 'development' (prod wording, task 4.1)", () => {
    expect(all.filter((s) => /develop/i.test(s))).toEqual([]);
  });

  it("carries no protocol or OAuth jargon", () => {
    const jargon = /\b(token|oauth|client[_ ]id|scope|pkce|consent code|authori[sz]ation code|manifest|elicitation|allow-?list|redirect|jwt|metadata)\b/i;
    expect(all.filter((s) => jargon.test(s))).toEqual([]);
  });

  it("the sign-in confirmation is one sentence for every address (spec 'Unknown address')", () => {
    const known = fill(copy.checkEmail.sentTo, { address: "a@example.com" });
    const unknown = fill(copy.checkEmail.sentTo, { address: "b@example.com" });
    expect(known.replace("a@example.com", "X")).toEqual(unknown.replace("b@example.com", "X"));
    expect(copy.checkEmail.sentTo).toMatch(/^If \{address\} can sign in/);
  });

  it("states the 15-minute validity on the sent and expired screens", () => {
    expect(copy.checkEmail.validity).toContain("15 minutes");
    expect(copy.linkExpired.body).toContain("15 minutes");
  });

  it("consent states the one rule on the principal side and names both scopes in plain words", () => {
    expect(copy.consent.approvalBody).toContain("shown to you for approval before it is sent");
    expect(copy.consent.scopes.a2h).toBe("Find humans, send them approved questions and read their answers on your behalf");
    expect(copy.consent.scopes.offline_access).toBe("Stay connected without signing in again");
  });

  it("fill leaves unknown placeholders visible rather than inventing text", () => {
    expect(fill("Connect {client}", {})).toBe("Connect {client}");
  });
});
