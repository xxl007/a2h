import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { approvalRequest, principalEmail, storyTimeZone } from "../src/fixtures.js";
import { ApprovalScreen, AuthShell, CheckEmailScreen, SignInScreen } from "../src/index.js";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const LANDMARK_TAGS = new Set(["header", "main", "nav", "footer", "aside"]);
const LANDMARK_ROLES = new Set(["banner", "main", "navigation", "contentinfo", "complementary", "region", "search", "form"]);

/**
 * The substance of axe's best-practice `region` rule on server markup: every piece of text must sit
 * inside a landmark. Returns the text found outside one. (header/footer count as landmarks here because
 * AuthShell never nests them in sectioning content.)
 */
function textOutsideLandmarks(html: string): string[] {
  const outside: string[] = [];
  const stack: boolean[] = [];
  const inLandmark = () => stack.some(Boolean);
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [, closing, tag, attrs = "", selfClosing, textChunk] = m;
    if (textChunk !== undefined) {
      if (textChunk.trim() !== "" && !inLandmark()) outside.push(textChunk.trim());
      continue;
    }
    const name = (tag ?? "").toLowerCase();
    if (closing) {
      stack.pop();
      continue;
    }
    if (VOID.has(name) || selfClosing) continue;
    const role = /\brole="([^"]+)"/.exec(attrs)?.[1];
    stack.push(LANDMARK_TAGS.has(name) || (role !== undefined && LANDMARK_ROLES.has(role)));
  }
  return outside;
}

const stageLine = "Test stage pr-75. Not the live service.";

describe("AuthShell stage line sits in a landmark (axe best-practice `region`)", () => {
  it("bare shell: no text outside a landmark, stage line present and read as a note", () => {
    const html = renderToStaticMarkup(
      <AuthShell stageName="pr-75" account={{ email: principalEmail }}>
        <p>Body</p>
      </AuthShell>,
    );
    expect(html).toContain(stageLine);
    expect(textOutsideLandmarks(html)).toEqual([]);
    expect(html).toMatch(new RegExp(`<p[^>]*role="note"[^>]*>${stageLine.replaceAll(".", "\\.")}</p>`));
  });

  it("the stage line keeps its place: after the wordmark and account row, before main", () => {
    const html = renderToStaticMarkup(
      <AuthShell stageName="pr-75" account={{ email: principalEmail }}>
        <p>Body</p>
      </AuthShell>,
    );
    const at = (s: string) => html.indexOf(s);
    expect(at("Sign out")).toBeLessThan(at(stageLine));
    expect(at(stageLine)).toBeLessThan(at("<main"));
  });

  it("approval, sign-in and check-email screens with a stage line: no text outside a landmark", () => {
    for (const html of [
      renderToStaticMarkup(<ApprovalScreen email={principalEmail} timeZone={storyTimeZone} state="awaiting" request={approvalRequest} stageName="pr-75" />),
      renderToStaticMarkup(<ApprovalScreen email={principalEmail} timeZone={storyTimeZone} state="expired" stageName="pr-75" />),
      renderToStaticMarkup(<SignInScreen next="/approve/A2H-7f3c" nextPurpose="approve" stageName="pr-75" />),
      renderToStaticMarkup(<CheckEmailScreen email={principalEmail} stageName="pr-75" />),
    ]) {
      expect(html).toContain(stageLine);
      expect(textOutsideLandmarks(html)).toEqual([]);
    }
  });

  it("production (no stage name): no stage line, no empty note", () => {
    const html = renderToStaticMarkup(<AuthShell account={{ email: principalEmail }}><p>Body</p></AuthShell>);
    expect(html).not.toContain("Test stage");
    expect(html).not.toContain('role="note"');
  });
});
