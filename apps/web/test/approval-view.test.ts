// m2-approval-page task 5.1-5.3: what the approval page shows, formatted at
// the edge from the stored request (design.md Screens A0 "Data the web dev
// passes"), and how a refused Send maps to its wording (A4). Pure.
import { describe, expect, test } from "vitest";
import { approvalRequestView, formatMoney, formatRate, refusalOf, submittedQuestion } from "../src/approval/view";

const NOW = new Date("2026-11-03T09:00:00Z");

const row = {
  id: "A2H-7f3c",
  intent: "judgment",
  format: "single_field",
  lane: "paid",
  free_lane: null,
  question: "Would a patient find this alarming?",
  agent_draft: "Would a patient find this alarming?",
  options: null,
  scale: null,
  data_terms: { storage: "principal_workspace", attribution: "not_attributed", training: "off" },
  bid_minor: 3500,
  currency: "EUR",
  deliver_at: NOW,
  expires_at: new Date("2026-11-04T11:20:00Z"),
  approval_expires_at: new Date("2026-11-04T09:20:00Z"),
};
const participant = { handle: "sim-mv-7f3c", display_label: "Margaret Vale (simulated)", simulated: true };

describe("formatting at the edge", () => {
  test("money in minor units, with cents", () => {
    expect(formatMoney(3500, "EUR")).toBe("€35.00");
    expect(formatMoney(2975, "EUR")).toBe("€29.75");
    expect(formatMoney(5, "GBP")).toBe("£0.05");
    expect(formatMoney(1234, "CHF")).toBe("12.34 CHF");
  });
  test("the fee rate as a percentage", () => {
    expect(formatRate(0.2)).toBe("20%");
    expect(formatRate(0.15)).toBe("15%");
    expect(formatRate(0.125)).toBe("12.5%");
    expect(formatRate(0)).toBe("0%");
  });
});

describe("Requirement: The page shows what the participant will receive", () => {
  test("Labels: a paid request with a gross bid of €35.00 holds €35.00, the breakdown at the full bid", () => {
    const v = approvalRequestView(row, participant, { feeRate: 0.2, now: NOW });
    expect(v.money).toEqual({ lane: "paid", hold: "€35.00", feeRate: "20%", fee: "€7.00", net: "€28.00" });
  });

  test("free lane: no hold, the lane named", () => {
    const v = approvalRequestView({ ...row, lane: "free", free_lane: "facts_about_self", bid_minor: 0 }, participant, { feeRate: 0.2, now: NOW });
    expect(v.money).toEqual({ lane: "free", freeLane: "facts_about_self" });
  });

  test("Poll request: every option label and the scale verbatim, in manifest order", () => {
    const options = [
      { id: "b", label: "Second <b>shown</b> first?" },
      { id: "a", label: "Ça va — «oui»" },
      { id: "c", label: "  spaced  " },
    ];
    const v = approvalRequestView({ ...row, intent: "opinion", format: "poll", options, scale: { min: 1, max: 7 } }, participant, { feeRate: 0.2, now: NOW });
    expect(v.options).toEqual(options);
    expect(v.scale).toEqual({ min: 1, max: 7 });
    expect(v.intent).toBe("opinion");
    expect(v.format).toBe("poll");
  });

  test("Simulated participant: label, handle and the flag come from the participant row", () => {
    const v = approvalRequestView(row, participant, { feeRate: 0.2, now: NOW });
    expect(v.participant).toEqual({ label: "Margaret Vale (simulated)", handle: "sim-mv-7f3c", simulated: true });
    const real = approvalRequestView(row, { handle: "mv-7f3c", display_label: "Margaret V.", simulated: false }, { feeRate: 0.2, now: NOW });
    expect(real.participant.simulated).toBe(false);
  });

  test("times as ISO for <time>; delivery only when it would be deferred", () => {
    const v = approvalRequestView(row, participant, { feeRate: 0.2, now: NOW });
    expect(v.expiresAt).toBe("2026-11-04T11:20:00.000Z");
    expect(v.approvalExpiresAt).toBe("2026-11-04T09:20:00.000Z");
    expect(v.deliverAt).toBeUndefined();
    const later = approvalRequestView({ ...row, deliver_at: new Date("2026-11-03T22:00:00Z") }, participant, { feeRate: 0.2, now: NOW });
    expect(later.deliverAt).toBe("2026-11-03T22:00:00.000Z");
  });

  test("data terms and the limit", () => {
    const v = approvalRequestView(row, participant, { feeRate: 0.2, now: NOW });
    expect(v.dataTerms).toEqual({ attribution: "not_attributed", training: "off" });
    expect(v.questionMaxLength).toBe(2000);
    expect(v.agentDraft).toBe(row.agent_draft);
  });

  test("an agent draft with CR LF is shown as the browser's textarea holds it (LF)", () => {
    const v = approvalRequestView({ ...row, agent_draft: "One\r\nTwo\rThree" }, participant, { feeRate: 0.2, now: NOW });
    expect(v.agentDraft).toBe("One\nTwo\nThree");
  });
});

describe("the submitted question", () => {
  test("Accept after editing: the browser's CR LF line breaks become the LF the principal's field held", () => {
    expect(submittedQuestion("Line one\r\nLine two", "Draft")).toBe("Line one\nLine two");
  });
  test("unchanged (up to line breaks): the agent's draft byte for byte", () => {
    expect(submittedQuestion("One\r\nTwo", "One\r\nTwo")).toBe("One\r\nTwo");
    expect(submittedQuestion("One\nTwo", "One\r\nTwo")).toBe("One\r\nTwo");
  });
  test("anything but text is no question", () => {
    expect(submittedQuestion(null, "Draft")).toBe("");
  });
});

describe("Validation failed after an edit: the category of a refused Send", () => {
  const error = (code: string) => ({ code, stage: "content", retryable: false }) as Parameters<typeof refusalOf>[0];
  test("forbidden content names its class when the edited question shows it", () => {
    expect(refusalOf(error("forbidden_content"), "Would you still trust this clinic if you learned its director lied about the results?")).toBe("persuasion_disguised");
    expect(refusalOf(error("forbidden_content"), "A neutral question?")).toBe("forbidden_content");
  });
  test("the other categories are their own codes", () => {
    for (const code of ["outside_participant_rules", "over_budget", "over_cap", "rate_limited", "principal_not_verified_for_lane", "schema_invalid"]) {
      expect(refusalOf(error(code), "q")).toBe(code);
    }
  });
  test("a code the page has no wording for is no refusal (the page shows the error state)", () => {
    expect(refusalOf(error("principal_not_accountable"), "q")).toBeUndefined();
    expect(refusalOf(error("conflict"), "q")).toBeUndefined();
  });
});
