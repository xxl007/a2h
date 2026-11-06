// The question as approved (spec protocol/request-approval "Accept after
// editing": byte-identical to the edited text), decided inside
// `decideApproval`'s transaction against the locked row's draft (review F2 of
// m2-approval-page: the page reads nothing on its own). Browsers post a
// textarea's line breaks as CR LF; the field held LF, so LF is what was
// approved. Unchanged up to line breaks, it is the agent's draft byte for byte.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { approvedQuestion } from "../src/index.ts";

describe("approvedQuestion (the posted text against the agent's draft)", () => {
  test("an edit is approved as the browser's field held it: CR LF becomes LF", () => {
    assert.equal(approvedQuestion("Line one\r\nLine two", "Draft"), "Line one\nLine two");
    assert.equal(approvedQuestion("Line one\rLine two", "Draft"), "Line one\nLine two");
  });
  test("unchanged (up to line breaks): the agent's draft byte for byte", () => {
    assert.equal(approvedQuestion("One\r\nTwo", "One\r\nTwo"), "One\r\nTwo");
    assert.equal(approvedQuestion("One\nTwo", "One\r\nTwo"), "One\r\nTwo");
    assert.equal(approvedQuestion("One\r\nTwo", "One\nTwo"), "One\nTwo");
  });
  test("the comparison is exact: a trailing space or a changed character is an edit", () => {
    assert.equal(approvedQuestion("Draft ", "Draft"), "Draft ");
    assert.equal(approvedQuestion("Drafts", "Draft"), "Drafts");
  });
});
