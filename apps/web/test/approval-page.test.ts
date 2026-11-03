// m2-approval-page tasks 5.1 and 5.2 against PostgreSQL 17: what /approve/[id]
// shows for a link (token first, then the principal, then the request's
// state) and what Send and Don't send do (packages/db `decideApproval`, D4).
// Scenario names are the spec's (platform/approval-page,
// protocol/request-approval). The session itself (signed in, allow-listed)
// is the page's and is covered by the auth tests and the e2e flows; here the
// principal id is the session's.
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { decide } from "../src/approval/decide";
import { loadApprovalPage } from "../src/approval/page-data";
import { createLogger } from "../src/log";
import { awaiting, DRAFT, events, principal, startApprovalDb, stored, type ApprovalDb } from "./lib/approval-db";

const adminUrl = inject("pgAdminUrl");
const FEE = 0.2;
const PUSH_POLL = "Would you still trust this clinic if you learned its director lied about the results?";
const FORGED = "A".repeat(42) + "A";

function form(decision: string, question?: string): FormData {
  const f = new FormData();
  f.set("decision", decision);
  if (question !== undefined) f.set("question", question);
  return f;
}

describe.skipIf(!adminUrl)("approval page against the database", () => {
  let d: ApprovalDb;
  let logLines: string[];
  let deps: Parameters<typeof decide>[0];
  let me: string;
  let other: string;
  const page = (id: string, token: string | undefined, principalId: string, now = new Date()) =>
    loadApprovalPage(d.db, { requestId: id, token, principalId, now, feeRate: FEE });
  const act = (id: string, token: string | undefined, principalId: string, f: FormData) =>
    decide(deps, { requestId: id, token, principalId, form: f, reference: "ref_test" });

  beforeAll(async () => {
    d = await startApprovalDb(adminUrl, "web_approval");
    logLines = [];
    deps = { db: d.db, feeRate: FEE, logger: createLogger({ write: (l) => logLines.push(l), level: "debug" }) };
    me = await principal(d, "user-approval-me");
    other = await principal(d, "user-approval-other");
  });
  afterAll(async () => {
    await d?.close();
  });

  describe("Requirement: Only the request's principal sees the request", () => {
    test("Wrong principal: the page says the link belongs to another account and shows nothing of the request", async () => {
      const a = await awaiting(d, me);
      const p = await page(a.id, a.token, other);
      expect(p).toEqual({ kind: "wrong-principal" });
    });

    test("a wrong token for another principal shows the expired link, never the wrong-account page (no id is confirmed)", async () => {
      const a = await awaiting(d, me);
      expect(await page(a.id, FORGED, other)).toEqual({ kind: "expired" });
    });

    test("the request's principal with its token sees the request awaiting a decision", async () => {
      const a = await awaiting(d, me);
      const p = await page(a.id, a.token, me);
      expect(p.kind).toBe("awaiting");
      if (p.kind !== "awaiting") return;
      expect(p.request.id).toBe(a.id);
      expect(p.request.agentDraft).toBe(DRAFT);
      expect(p.request.participant).toEqual({ label: "Margaret Vale (simulated)", handle: "sim-mv-7f3c", simulated: true });
      expect(p.request.money).toEqual({ lane: "paid", hold: "€35.00", feeRate: "20%", fee: "€7.00", net: "€28.00" });
    });
  });

  describe("Requirement: The link is single-use and bound to its principal", () => {
    test("Forged token: the same response as an expired link, for a known id and for an unknown one", async () => {
      const a = await awaiting(d, me);
      expect(await page(a.id, FORGED, me)).toEqual({ kind: "expired" });
      expect(await page("A2H-ffff", FORGED, me)).toEqual({ kind: "expired" });
      expect(await page(a.id, undefined, me)).toEqual({ kind: "expired" });
      expect(await page(a.id, "not a token", me)).toEqual({ kind: "expired" });
      expect(await act(a.id, FORGED, me, form("send", DRAFT))).toEqual({ state: "expired" });
      expect((await stored(d, a.id))!.status).toBe("awaiting_approval");
    });

    test("Another principal opens the link: nothing shown, no action, the request unchanged", async () => {
      const a = await awaiting(d, me);
      expect(await act(a.id, a.token, other, form("send", DRAFT))).toEqual({ state: "wrong-principal" });
      expect(await act(a.id, a.token, other, form("dont_send"))).toEqual({ state: "wrong-principal" });
      expect(await stored(d, a.id)).toEqual({ status: "awaiting_approval", question: DRAFT, not_sent_reason: null });
      expect(await events(d, a.id)).toBe(1);
    });

    test("Decision replayed: nothing changes, no second transition, the page shows the decision already taken", async () => {
      const a = await awaiting(d, me);
      const first = await act(a.id, a.token, me, form("send", DRAFT));
      expect(first.state).toBe("sent");
      const before = await events(d, a.id);
      const again = await act(a.id, a.token, me, form("send", "A different text"));
      expect(again).toMatchObject({ state: "already-sent", question: DRAFT });
      expect(await act(a.id, a.token, me, form("dont_send"))).toMatchObject({ state: "already-sent" });
      expect(await events(d, a.id)).toBe(before);
      expect((await stored(d, a.id))!.status).toBe("sent");
    });
  });

  describe("Requirement: Approval happens on the hosted approval page", () => {
    test("Send on the page: the request becomes sent with the question unchanged", async () => {
      const a = await awaiting(d, me);
      const r = await act(a.id, a.token, me, form("send", DRAFT));
      expect(r).toMatchObject({ state: "sent", question: DRAFT });
      if (r.state === "sent") expect(Number.isNaN(Date.parse(r.decidedAt))).toBe(false);
      expect(await stored(d, a.id)).toEqual({ status: "sent", question: DRAFT, not_sent_reason: null });
    });

    test("Don't send on the page: not_sent with reason declined, nothing sent", async () => {
      const a = await awaiting(d, me);
      expect(await act(a.id, a.token, me, form("dont_send", "whatever was typed"))).toEqual({ state: "not-sent" });
      expect(await stored(d, a.id)).toEqual({ status: "not_sent", question: DRAFT, not_sent_reason: "declined" });
    });

    test("Link expires unused: opening it shows that it expired", async () => {
      const now = new Date();
      const a = await awaiting(d, me, { now: new Date(now.getTime() - 2 * 3_600_000), approvalExpiresAt: new Date(now.getTime() - 60_000) });
      expect(await page(a.id, a.token, me, now)).toEqual({ kind: "expired" });
      expect(await act(a.id, a.token, me, form("send", DRAFT))).toEqual({ state: "expired" });
      expect(await stored(d, a.id)).toMatchObject({ status: "not_sent", not_sent_reason: "expired" });
      expect(await page(a.id, a.token, me, now)).toEqual({ kind: "expired" });
    });

    test("an unknown decision value changes nothing", async () => {
      const a = await awaiting(d, me);
      expect((await act(a.id, a.token, me, form("approve", DRAFT))).state).toBe("error");
      expect((await stored(d, a.id))!.status).toBe("awaiting_approval");
    });
  });

  describe("Requirement: Approval covers the validated manifest", () => {
    test("Accept after editing: sent with a question byte-identical to the edited text", async () => {
      const a = await awaiting(d, me);
      const edited = "Would a newly diagnosed patient find it alarming? (é, «quotes», 中文)\nLine two.";
      // The browser posts the textarea's line breaks as CR LF.
      const r = await act(a.id, a.token, me, form("send", edited.replace(/\n/g, "\r\n")));
      expect(r).toMatchObject({ state: "sent", question: edited });
      expect((await stored(d, a.id))!.question).toBe(edited);
    });

    test("Edit turns the question into a push-poll: refused with its category, the edited text kept, the request still awaiting", async () => {
      const a = await awaiting(d, me);
      const r = await act(a.id, a.token, me, form("send", PUSH_POLL));
      expect(r).toEqual({ state: "refused", refusal: "persuasion_disguised", question: PUSH_POLL });
      expect(await stored(d, a.id)).toEqual({ status: "awaiting_approval", question: DRAFT, not_sent_reason: null });
      // Both actions stay available: a valid Send afterwards goes through.
      expect((await act(a.id, a.token, me, form("send", DRAFT))).state).toBe("sent");
    });

    test("Budget spent meanwhile: Send fails with over_budget and nothing is held", async () => {
      const poor = await principal(d, "user-approval-poor", { monthly_budget_minor: 5_000 });
      const first = await awaiting(d, poor);
      const second = await awaiting(d, poor);
      expect((await act(first.id, first.token, poor, form("send", DRAFT))).state).toBe("sent");
      const r = await act(second.id, second.token, poor, form("send", DRAFT));
      expect(r).toEqual({ state: "refused", refusal: "over_budget", question: DRAFT });
      expect((await stored(d, second.id))!.status).toBe("awaiting_approval");
    });

    test("Over the limit: a question past 2000 characters is refused by the server too (schema)", async () => {
      const a = await awaiting(d, me);
      const r = await act(a.id, a.token, me, form("send", "x".repeat(2001)));
      expect(r).toMatchObject({ state: "refused", refusal: "schema_invalid" });
      expect((await stored(d, a.id))!.status).toBe("awaiting_approval");
    });
  });

  describe("Requirement: Every state of the page is stated", () => {
    test("Already decided: a sent request opened again says it was sent, when, with the question as sent", async () => {
      const a = await awaiting(d, me);
      await act(a.id, a.token, me, form("send", DRAFT));
      const p = await page(a.id, a.token, me);
      expect(p).toMatchObject({ kind: "already-sent", question: DRAFT });
      if (p.kind === "already-sent") expect(Number.isNaN(Date.parse(p.decidedAt))).toBe(false);
    });

    test("Already decided: a request the principal chose not to send", async () => {
      const a = await awaiting(d, me);
      await act(a.id, a.token, me, form("dont_send"));
      expect(await page(a.id, a.token, me)).toMatchObject({ kind: "already-not-sent" });
    });
  });

  test("logs carry ids and codes, never the token or the question", async () => {
    const a = await awaiting(d, me);
    await act(a.id, a.token, me, form("send", PUSH_POLL));
    await act(a.id, a.token, me, form("send", DRAFT));
    const all = logLines.join("\n");
    expect(all).toContain(a.id);
    expect(all).not.toContain(a.token);
    expect(all).not.toContain("clinic");
    expect(all).not.toContain("diabetes");
  });
});
