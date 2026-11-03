// m2-approval-page tasks 5.1-5.3: the approval page as the server renders it
// (react-dom/server, no client JavaScript: what a reader with JavaScript off
// gets, design D7). One test per page state and per spec scenario that a
// server render can show; the interactive ones (Restore, Over the limit
// while typing, Enter, Time zone, Keyboard only, Narrow screen) are the
// Playwright flows in test/e2e/approval.spec.ts.
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalRequest } from "@a2h/ui";
import { ApprovalForm, documentTitle } from "../app/_ui/approval";
import type { ApprovalActionState } from "../src/approval/decide";
import type { ApprovalPageModel } from "../src/approval/page-data";

const request: ApprovalRequest = {
  id: "A2H-7f3c",
  participant: { label: "Margaret Vale (simulated)", handle: "sim-mv-7f3c", simulated: true },
  intent: "judgment",
  format: "single_field",
  money: { lane: "paid", hold: "€35.00", feeRate: "20%", fee: "€7.00", net: "€28.00" },
  expiresAt: "2026-11-04T11:20:00.000Z",
  dataTerms: { attribution: "not_attributed", training: "off" },
  agentDraft: "Would a patient find this alarming?\nSecond line.",
  questionMaxLength: 2000,
  approvalExpiresAt: "2026-11-04T09:20:00.000Z",
};

const noop = (s: ApprovalActionState) => Promise.resolve(s);

function render(model: ApprovalPageModel, initial?: ApprovalActionState): string {
  return renderToStaticMarkup(
    <ApprovalForm model={model} action={noop} email="principal@example.com" stageName="pr-12" {...(initial ? { initialState: initial } : {})} />,
  );
}

const forms = (html: string) => html.match(/<form[\s\S]*?<\/form>/g) ?? [];
const decisionForm = (html: string) => forms(html).find((f) => f.includes('name="decision"')) ?? "";

describe("Requirement: Two actions, money on the send action", () => {
  test("Labels: a paid request of €35.00 reads 'Send · hold €35.00' and 'Don't send'", () => {
    const html = render({ kind: "awaiting", request });
    expect(html).toContain("Send · hold €35.00");
    expect(html).toContain("Don&#x27;t send");
    const buttons = decisionForm(html).match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b).toContain('type="submit"');
      expect(b).toContain('name="decision"');
      expect(b).not.toMatch(/autofocus/i);
    }
    expect(buttons[0]).toContain('value="send"');
    expect(buttons[1]).toContain('value="dont_send"');
  });

  test("free lane: 'Send', nothing held", () => {
    const html = render({ kind: "awaiting", request: { ...request, money: { lane: "free", freeLane: "facts_about_self" } } });
    expect(decisionForm(html)).toMatch(/>Send<\/button>|>Send</);
    expect(html).not.toContain("Send · hold");
  });

  test("Enter in the question: the form holds no single-line field, so the browser never submits implicitly", () => {
    const form = decisionForm(render({ kind: "awaiting", request }));
    expect(form).toMatch(/<textarea[^>]*name="question"/);
    const inputs = (form.match(/<input[^>]*>/g) ?? []).filter((i) => !/type="hidden"/.test(i));
    expect(inputs).toEqual([]);
  });
});

describe("Requirement: The question is editable in place", () => {
  test("the field holds the agent's draft, with no maxlength (a pasted text is kept whole) and its count", () => {
    const html = render({ kind: "awaiting", request });
    const textarea = html.match(/<textarea[^>]*>[\s\S]*?<\/textarea>/)?.[0] ?? "";
    expect(textarea).toContain("Would a patient find this alarming?\nSecond line.");
    expect(textarea).not.toMatch(/maxlength/i);
    expect(html).toContain(`${request.agentDraft.length} / 2000`);
    // Restore needs script and appears only once the text differs.
    expect(html).not.toContain("Restore agent draft");
  });
});

describe("Requirement: The page shows what the participant will receive", () => {
  test("Simulated participant: said next to the label, and that no person will be asked", () => {
    const html = render({ kind: "awaiting", request });
    expect(html).toContain("Margaret Vale (simulated)");
    expect(html).toContain("sim-mv-7f3c");
    expect(html).toContain("Simulated participant: no person will be asked.");
  });

  test("Poll request: options and scale verbatim, in order", () => {
    const options = [
      { id: "b", label: "Second <b>first</b>" },
      { id: "a", label: "Ça va — «oui»" },
    ];
    const html = render({ kind: "awaiting", request: { ...request, intent: "opinion", format: "poll", options, scale: { min: 1, max: 7 } } });
    const i = html.indexOf("Second &lt;b&gt;first&lt;/b&gt;");
    const j = html.indexOf("Ça va — «oui»");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(html).toContain("They answer on a scale from 1 to 7.");
  });

  test("the hold with its breakdown, and times rendered in UTC with their offset before the browser's zone takes over", () => {
    const html = render({ kind: "awaiting", request });
    expect(html).toContain("€35.00, held when you send");
    expect(html).toContain("Includes the A2H fee (20%): at your full bid, €28.00 goes to them and €7.00 to A2H.");
    expect(html).toContain('<time dateTime="2026-11-04T11:20:00.000Z">11:20 on 4 Nov 2026 (UTC)</time>');
    expect(html).not.toMatch(/>\s*2026-11-04T/);
  });

  test("the stage line shows off prod", () => {
    expect(render({ kind: "awaiting", request })).toContain("Test stage pr-12.");
  });
});

describe("Requirement: Every state of the page is stated", () => {
  test("Link expired (and a forged link): no id, no participant, no amount, no action", () => {
    const html = render({ kind: "expired" });
    expect(html).toContain("This approval link has expired");
    for (const leak of ["A2H-", "Margaret", "€", 'name="decision"', "<textarea"]) expect(html).not.toContain(leak);
  });

  test("Wrong principal: the link belongs to another account; nothing about the request", () => {
    const html = render({ kind: "wrong-principal" });
    expect(html).toContain("This link belongs to another account");
    expect(html).toContain("principal@example.com");
    for (const leak of ["A2H-", "Margaret", "€", 'name="decision"', "<textarea", "alarming"]) expect(html).not.toContain(leak);
  });

  test("Already decided: sent, when, that the agent can check it, and no action", () => {
    const html = render({ kind: "already-sent", request, question: "The sent text", decidedAt: "2026-11-03T10:00:00.000Z" });
    expect(html).toContain("This question was already sent");
    expect(html).toContain("10:00 on 3 Nov 2026 (UTC)");
    expect(html).toContain("ask it to check on this request");
    expect(html).toContain("Nothing more can be decided on this page.");
    expect(html).toContain("The sent text");
    expect(html).not.toContain('name="decision"');
  });

  test("Already decided: not sent by the principal", () => {
    const html = render({ kind: "already-not-sent", request, decidedAt: "2026-11-03T10:00:00.000Z" });
    expect(html).toContain("This request was not sent");
    expect(html).not.toContain('name="decision"');
  });

  test("Validation failed after an edit: the edited text kept, the category named, both actions available", () => {
    const html = render({ kind: "awaiting", request }, { state: "refused", refusal: "persuasion_disguised", question: "Edited push-poll text" });
    expect(html).toContain("This wording can&#x27;t be sent");
    expect(html).toContain("reads as persuasion");
    expect(html).toContain("Nothing was sent and nothing is held.");
    expect(html.match(/<textarea[^>]*>[\s\S]*?<\/textarea>/)?.[0]).toContain("Edited push-poll text");
    const buttons = decisionForm(html).match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).not.toMatch(/\sdisabled/);
  });

  test("error: not recorded, with the reference, edits kept", () => {
    const html = render({ kind: "awaiting", request }, { state: "error", reference: "ref_0123456789abcdef", question: "Kept edit" });
    expect(html).toContain("Your choice was not recorded");
    expect(html).toContain("ref_0123456789abcdef");
    expect(html).toContain("Kept edit");
  });

  test("sent and not sent after the action", () => {
    const sent = render({ kind: "awaiting", request }, { state: "sent", decidedAt: "2026-11-03T10:00:00.000Z", question: "Final text" });
    expect(sent).toContain("Question sent");
    expect(sent).toContain("€35.00");
    expect(sent).toContain("Final text");
    expect(sent).not.toContain('name="decision"');
    const notSent = render({ kind: "awaiting", request }, { state: "not-sent" });
    expect(notSent).toContain("Margaret Vale (simulated) was not contacted");
    expect(notSent).not.toContain('name="decision"');
  });

  test("an action that finds the link expired or the account wrong shows those states", () => {
    expect(render({ kind: "awaiting", request }, { state: "expired" })).toContain("This approval link has expired");
    expect(render({ kind: "awaiting", request }, { state: "wrong-principal" })).toContain("This link belongs to another account");
  });

  test("document titles per state", () => {
    expect(documentTitle("awaiting")).toBe("Review a question · A2H");
    expect(documentTitle("sent")).toBe("Question sent · A2H");
    expect(documentTitle("already-sent")).toBe("Question sent · A2H");
    expect(documentTitle("not-sent")).toBe("Not sent · A2H");
    expect(documentTitle("expired")).toBe("Approval link expired · A2H");
    expect(documentTitle("wrong-principal")).toBe("Another account · A2H");
  });
});

describe("Never on this page", () => {
  test("no ISO string as text, no protocol values, no 'development', no model call", () => {
    const html = render({ kind: "awaiting", request });
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/single_field|not_attributed|principal_workspace|_minor/);
    expect(text.toLowerCase()).not.toContain("development");
  });
});
