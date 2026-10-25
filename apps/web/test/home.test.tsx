// Task 5.3 (m0-foundation): apps/web renders one page.
// The page body is a pure component, rendered here with react-dom/server,
// exactly as the server renders it (no client JavaScript is involved).
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Home } from "../app/home";
import * as page from "../app/page";

const SENTENCE =
  "A2H (Agent-to-Human) is a protocol and platform that lets AI agents find consenting humans, send them questions on behalf of an accountable principal, and bring back attested answers.";

function render(props: Parameters<typeof Home>[0]): string {
  return renderToStaticMarkup(<Home {...props} />);
}

describe("Home", () => {
  test("has one main landmark, one h1 'A2H' and the PRD summary sentence", () => {
    const html = render({});
    expect(html.match(/<main[\s>]/g)).toHaveLength(1);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain("<h1>A2H</h1>");
    expect(html).toContain(SENTENCE);
  });

  test("shows the stage and the MCP endpoint when they are set", () => {
    const html = render({ stage: "pr-12", mcpUrl: "http://a2h-alb.example/pr-12/mcp" });
    expect(html).toContain("pr-12");
    expect(html).toMatch(/Stage[\s\S]*pr-12/);
    expect(html).toMatch(/MCP endpoint[\s\S]*http:\/\/a2h-alb\.example\/pr-12\/mcp/);
  });

  test("omits the stage and the MCP endpoint when they are not set", () => {
    const html = render({});
    expect(html).not.toContain("Stage");
    expect(html).not.toContain("MCP endpoint");
  });

  test("treats an empty value as not set", () => {
    const html = render({ stage: "", mcpUrl: "" });
    expect(html).not.toContain("Stage");
    expect(html).not.toContain("MCP endpoint");
  });

  test("escapes the values it shows", () => {
    const html = render({ stage: "<script>x</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("app/page", () => {
  // STAGE and MCP_URL are set on the Lambda at run time, not at build time:
  // a statically prerendered page would freeze the build environment's values.
  test("is rendered per request, not prerendered at build", () => {
    expect(page.dynamic).toBe("force-dynamic");
  });
});
