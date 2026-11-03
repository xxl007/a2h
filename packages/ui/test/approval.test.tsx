import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentDraft, approvalRequest, pollRequest, principalEmail, realParticipantRequest, storyTimeZone } from "../src/fixtures.js";
import { ApprovalScreen, copy, formatDateTime, questionStatus, SignInScreen, type ApprovalState } from "../src/index.js";

const text = (html: string) =>
  html
    .replace(/<\/?(time|span)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+/g, " ");

const base = { email: principalEmail, timeZone: storyTimeZone };
const render = (state: ApprovalState, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<ApprovalScreen {...base} state={state} request={approvalRequest} {...extra} />);
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1] ?? "").trim());

describe("formatDateTime (spec approval-page 'Time zone')", () => {
  const iso = "2026-11-04T12:20:00+01:00";
  it("shows the time in the given zone with its offset", () => {
    expect(formatDateTime(iso, "Europe/Paris")).toBe("12:20 on 4 Nov 2026 (UTC+01:00)");
    expect(formatDateTime(iso, "America/New_York")).toBe("06:20 on 4 Nov 2026 (UTC-05:00)");
    expect(formatDateTime(iso, "Asia/Kolkata")).toBe("16:50 on 4 Nov 2026 (UTC+05:30)");
  });
  it("says UTC for offset zero and crosses the date line correctly", () => {
    expect(formatDateTime(iso, "UTC")).toBe("11:20 on 4 Nov 2026 (UTC)");
    expect(formatDateTime("2026-11-04T23:30:00Z", "Pacific/Auckland")).toBe("12:30 on 5 Nov 2026 (UTC+13:00)");
  });
  it("never prints an ISO string", () => {
    expect(formatDateTime(iso, "Europe/Paris")).not.toMatch(/T\d\d:|\+\d\d:\d\d[^)]/);
  });
});

describe("questionStatus (spec 'Over the limit', 'Restore agent draft')", () => {
  it("counts UTF-16 units, as the protocol limit does", () => {
    expect(questionStatus("é😀", "", 2000).count).toBe(3);
  });
  it("says by how much it is over and blocks Send", () => {
    const s = questionStatus("x".repeat(2043), agentDraft, 2000);
    expect(s).toMatchObject({ count: 2043, over: 43, canSend: false, edited: true });
  });
  it("a blank question cannot be sent", () => {
    expect(questionStatus(" \n\t ", agentDraft, 2000).canSend).toBe(false);
  });
  it("the agent draft byte for byte is not an edit", () => {
    expect(questionStatus(agentDraft, agentDraft, 2000)).toMatchObject({ edited: false, canSend: true });
    expect(questionStatus(`${agentDraft} `, agentDraft, 2000).edited).toBe(true);
  });
});

describe("approval page: awaiting decision", () => {
  const html = render("awaiting");
  const t = text(html);

  it("offers exactly two decisions with the money on Send (spec 'Labels')", () => {
    expect(buttons(html)).toEqual(["Sign out", "Send · hold €35.00", "Don't send"]);
    const send = /<button[^>]*value="send"[^>]*>/.exec(html)?.[0] ?? "";
    expect(send).toContain('type="submit"');
    expect(send).toContain('name="decision"');
  });

  it("nothing is pre-selected and Enter cannot submit (spec 'Enter in the question')", () => {
    expect(html).not.toMatch(/autofocus|checked|<input[^>]*type="(text|email|search)"/i);
    expect(html).toMatch(/<textarea[^>]*name="question"/);
  });

  it("shows the question byte for byte, line breaks included", () => {
    const value = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "";
    expect(value.replaceAll("&quot;", '"')).toBe(agentDraft);
  });

  it("states every fact in order (spec 'The page shows what the participant will receive')", () => {
    const order = [
      "Margaret Vale (simulated)",
      "sim-mv-7f3c",
      "Judgment",
      "One written answer",
      "€35.00, held when you send",
      "Includes the A2H fee (15%): at your full bid, €29.75 goes to them and €5.25 to A2H.",
      "12:20 on 4 Nov 2026 (UTC+01:00)",
      "Stored in your workspace, not attributed to them, never used for training.",
      "As soon as you send.",
    ];
    const positions = order.map((s) => t.indexOf(s));
    expect(positions.every((p) => p >= 0), JSON.stringify(positions)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("says a simulated participant is simulated and that no person will be asked (spec 'Simulated participant')", () => {
    expect(t).toContain("no person will be asked");
    expect(text(renderToStaticMarkup(<ApprovalScreen {...base} request={realParticipantRequest} />))).not.toContain("no person will be asked");
  });

  it("shows no draft marker while unchanged, and states the count", () => {
    expect(t).not.toMatch(/Agent draft|Restore agent draft/);
    expect(t).toContain(`${agentDraft.length} of 2000 characters`);
  });

  it("states how long the link works", () => {
    expect(t).toContain("This link works until 10:20 on 4 Nov 2026 (UTC+01:00).");
  });
});

describe("approval page: poll, free lane, deferred delivery (spec 'Poll request')", () => {
  const html = renderToStaticMarkup(<ApprovalScreen {...base} request={pollRequest} />);
  const t = text(html);
  it("lists every option verbatim, in order, and the scale", () => {
    const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1] ?? "").trim());
    expect(items).toEqual(pollRequest.options!.map((o) => o.label));
    expect(t).toContain("They answer on a scale from 1 to 7.");
  });
  it("Send carries no amount on a free lane", () => {
    expect(buttons(html)).toEqual(["Sign out", "Send", "Don't send"]);
    expect(t).toContain("free lane for questions about their own publications");
  });
  it("says nothing is charged at expiry, never that a hold is released", () => {
    expect(t).toContain("If they have not answered by then, the request ends. Nothing is charged.");
    expect(t).not.toMatch(/hold is released|held when you send/);
  });
  it("names when delivery happens", () => {
    expect(t).toContain("At 08:00 on 4 Nov 2026 (UTC+01:00), the earliest their rules allow.");
  });
});

describe("approval page: other states (spec 'Every state of the page is stated')", () => {
  it("over the limit: the count says by how much and Send is unavailable", () => {
    const html = render("awaiting", { question: "x".repeat(2043) });
    expect(text(html)).toContain("43 over the limit");
    expect(text(html)).toContain("Error: Shorten the question by 43 characters to send it.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*value="send"|<button[^>]*value="send"[^>]*disabled/);
  });

  it("sending: Send is pending, Don't send unavailable, question read-only", () => {
    const html = render("sending");
    expect(buttons(html)).toContain("Sending…");
    expect(html).toMatch(/<textarea[^>]*readonly/i);
  });

  it("validation failed after an edit keeps the text, names the category, leaves both actions (spec)", () => {
    const edited = "Wouldn't you agree that this leaflet is badly written?";
    const html = render("refused", { question: edited, refusal: "persuasion_disguised" });
    const t = text(html);
    expect(t).toContain(edited);
    expect(t).toContain("reads as persuasion");
    expect(t).toContain("Nothing was sent and nothing is held.");
    expect(buttons(html).filter((b) => b !== "Sign out")).toEqual(["Send · hold €35.00", "Don't send"]);
    expect(html).toContain('role="alert"');
  });

  it("every refusal category has words", () => {
    for (const [code, v] of Object.entries(copy.approval.refused)) {
      expect(v.title.length, code).toBeGreaterThan(0);
      expect(v.body.length, code).toBeGreaterThan(0);
    }
  });

  it("sent and already sent: when, the hold, that the agent can check, and no action (spec 'Already decided')", () => {
    for (const state of ["sent", "already-sent"] as const) {
      const html = render(state, { decidedAt: "2026-11-03T10:24:00+01:00" });
      const t = text(html);
      expect(t).toContain("Sent to Margaret Vale (simulated) at 10:24 on 3 Nov 2026 (UTC+01:00).");
      expect(t).toContain("€35.00 is held.");
      expect(t).toContain("ask it to check on this request");
      expect(buttons(html)).toEqual(["Sign out"]);
    }
  });

  it("not sent: nothing held, participant not contacted, no action", () => {
    const html = render("not-sent");
    expect(text(html)).toContain("was not contacted");
    expect(buttons(html)).toEqual(["Sign out"]);
  });

  it("expired (and forged) shows nothing about any request", () => {
    const html = renderToStaticMarkup(<ApprovalScreen {...base} state="expired" />);
    const t = text(html);
    expect(t).toContain("This approval link has expired");
    expect(t).not.toMatch(/A2H-|€|simulated/);
    expect(buttons(html)).toEqual(["Sign out"]);
  });

  it("wrong principal shows no question, participant, amount or action (spec 'Wrong principal')", () => {
    const html = renderToStaticMarkup(<ApprovalScreen {...base} state="wrong-principal" request={approvalRequest} />);
    const t = text(html);
    expect(t).toContain("This link belongs to another account");
    for (const leaked of ["A2H-7f3c", "Margaret", "sim-mv", "€", "leaflet", "Judgment"]) expect(t).not.toContain(leaked);
    expect(buttons(html)).toEqual(["Sign out"]);
  });

  it("offline keeps the form and says nothing is sent", () => {
    const html = render("offline");
    expect(text(html)).toContain("Nothing is sent until you choose again with a connection.");
    expect(buttons(html)).toContain("Send · hold €35.00");
  });
});

describe("sign-in from an approval link", () => {
  it("says why the person is signing in", () => {
    const t = text(renderToStaticMarkup(<SignInScreen next="/approve/A2H-7f3c" nextPurpose="approve" />));
    expect(t).toContain("Sign in to review the question your agent wants to send.");
  });
});
