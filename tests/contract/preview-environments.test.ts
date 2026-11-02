// Contract tests against a live preview for the modified scenarios of
// openspec/changes/m1-hosted-connector/specs/platform/preview-environments/spec.md:
// the hostnames of a preview under the domain and its own authorization
// server ("PR opened"), and "Preview tokens stay on the preview". "PR
// updated" and "PR closed" are workflow behaviour (tests/ci/workflows.test.mjs,
// tests/ci/pr-schema.pg.test.sh; see tests/README.md).
// Run: A2H_MCP_URL=https://mcp.dev.<domain>/pr-<n>/mcp A2H_WEB_URL=… A2H_TOKEN=… pnpm --filter @a2h/tests contract
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { domain, publicUrls, stageInfo } from "../../infra/config.ts";
import { bearerToken, devGate, devMcpUrl, expectedStage, issuer, mcpUrl, metadataUrl } from "../src/live-env.ts";

const MCP_URL = mcpUrl();
const STAGE = expectedStage(MCP_URL);
const notPreview = STAGE.startsWith("pr-") ? false : `${STAGE} is not a preview`;
const notDeployed = MCP_URL.protocol === "https:" ? false : `${MCP_URL.host} is a local stage, not a deployed preview`;
// The cross-stage refusal needs dev to run the gate (dev deploys from main).
const DEV_GATE = notPreview ? { on: false as const, reason: notPreview } : await devGate();

describe("Requirement: A PR gets a preview stage", () => {
  test("Scenario: PR opened (hostnames): the preview's web and MCP URLs are the derived ones under the domain, over HTTPS, with its own authorization server", { skip: notPreview || notDeployed || (domain ? false : "no domain in infra/config.ts") }, async () => {
    const urls = publicUrls(stageInfo(STAGE), domain!);
    assert.equal(MCP_URL.href.replace(/\/$/, ""), urls.mcp, "A2H_MCP_URL is the derived preview MCP URL");
    assert.equal(MCP_URL.protocol, "https:");
    const web = process.env["A2H_WEB_URL"]?.trim().replace(/\/$/, "");
    if (web) assert.equal(web, urls.web, "A2H_WEB_URL is the derived preview web URL");
    assert.equal(await issuer(STAGE), `${urls.web}/api/auth`, "the preview's own authorization server");
    const doc = (await (await fetch(metadataUrl(MCP_URL), { signal: AbortSignal.timeout(10_000) })).json()) as { authorization_servers?: string[] };
    assert.deepEqual(doc.authorization_servers, [`${urls.web}/api/auth`]);
  });

  test("Scenario: PR updated", { skip: "two deploys of one PR: the URLs in the preview comment are compared by eye; structure in tests/ci/workflows.test.mjs" }, () => {});

  test("Scenario: Preview tokens stay on the preview: this preview's token presented to the development stage's MCP endpoint is refused", { skip: notPreview || (DEV_GATE.on ? false : DEV_GATE.reason) || (bearerToken() ? false : "needs A2H_TOKEN") }, async () => {
    const dev = await devMcpUrl();
    assert.notEqual(dev.href, MCP_URL.href);
    const res = await fetch(dev, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearerToken()!}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_humans", arguments: { topic: "x", request_type: "judgment" } } }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(res.status, 401, `dev served a preview's token: HTTP ${res.status}`);
    assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
    assert.ok((res.headers.get("www-authenticate") ?? "").includes(metadataUrl(dev).href), "dev's challenge points at dev's own metadata");
  });
});

describe("Requirement: Teardown on close", () => {
  test("Scenario: PR closed", { skip: "tests/ci/pr-schema.pg.test.sh (schema dropped), tests/ci/workflows.test.mjs (order); the hostname's disappearance is checked by hand after a close" }, () => {});
});
