// Task 5.3 (m0-foundation): apps/web renders one page.
// The page body is a pure component, rendered here with react-dom/server,
// exactly as the server renders it (no client JavaScript is involved).
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Home } from "../app/home";
import * as page from "../pages/index";

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

describe("pages/index (the home route)", () => {
  // STAGE and MCP_URL are set on the Lambda at run time, not at build time:
  // a statically prerendered page would freeze the build environment's values.
  test("is rendered per request, not prerendered at build", async () => {
    const props = await page.getServerSideProps({} as never);
    expect(props).toHaveProperty("props");
  });

  test("reads the stage and the MCP URL from the environment at request time", async () => {
    process.env["STAGE"] = "pr-12";
    process.env["MCP_URL"] = "http://a2h-alb.example/pr-12/mcp";
    try {
      const result = (await page.getServerSideProps({} as never)) as { props: Parameters<typeof Home>[0] };
      expect(result.props).toEqual({ stage: "pr-12", mcpUrl: "http://a2h-alb.example/pr-12/mcp" });
      const html = renderToStaticMarkup(<page.default {...result.props} />);
      expect(html).toMatch(/Stage[\s\S]*pr-12/);
    } finally {
      delete process.env["STAGE"];
      delete process.env["MCP_URL"];
    }
  });

  // The page is text: it ships no client JavaScript at all (tests/e2e/hello.spec.ts
  // "transfers under 100 KB": the React runtime alone is 95-104 KB on the wire,
  // brotli or gzip, so a page that needs none of it must not load it).
  test("ships no client JavaScript: the Pages Router runtime is switched off", () => {
    expect(page.config.unstable_runtimeJS).toBe(false);
  });
});
