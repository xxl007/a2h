// m1-hosted-connector task 7.1 (design D3): the MCP endpoint as an OAuth 2.1
// resource server. Spec platform/connector-authorization: "Missing or invalid
// token is challenged", "Protected-resource metadata is served per stage",
// "Tokens are verified locally against the authorization server's keys",
// "Open paths stay open"; platform/mcp-transport "Handshake without a token".
// A test authorization server (lib/auth-server.ts) publishes the keys.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import { createMcpServer } from "../src/mcp-server.ts";
import { connect, start, type Running } from "./helpers.ts";
import { startAuthServer, TEST_RESOURCE, withToken, type TestAuthServer } from "./lib/auth-server.ts";

const METADATA_URL = "https://mcp.dev.a2h.test/.well-known/oauth-protected-resource/mcp";
const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};

let as: TestAuthServer;
before(async () => {
  as = await startAuthServer();
});
after(async () => {
  await as.stop();
});

function auth(pingOpen: boolean, resourceUrl = TEST_RESOURCE) {
  return { required: true, issuer: as.issuer, jwksUrl: as.jwksUrl, resourceUrl, pingOpen };
}

async function post(s: Running, body: unknown, token?: string, path = "/mcp"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return fetch(`${s.origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** A server whose factory counts how often an MCP server was built. */
async function counted(pingOpen = false): Promise<{ s: Running; created: () => number }> {
  let n = 0;
  const base: McpServerFactory = () => {
    n++;
    return createMcpServer("test");
  };
  const s = await start({ auth: auth(pingOpen), factory: base });
  return { s, created: () => n };
}

describe("Requirement: Missing or invalid token is challenged", () => {
  test("Scenario: No token: 401, WWW-Authenticate Bearer resource_metadata and scope, empty body, no MCP handler ran", async () => {
    const { s, created } = await counted(false);
    try {
      const res = await post(s, TOOLS_LIST);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("www-authenticate"), `Bearer resource_metadata="${METADATA_URL}", scope="a2h"`);
      assert.equal(await res.text(), "");
      assert.equal(created(), 0);
    } finally {
      await s.stop();
    }
  });

  test("Scenario: Expired token: 401 error=invalid_token with the same resource_metadata", async () => {
    const { s, created } = await counted(false);
    try {
      const token = await as.mint({ exp: Math.floor(Date.now() / 1000) - 60 });
      const res = await post(s, TOOLS_LIST, token);
      assert.equal(res.status, 401);
      const challenge = res.headers.get("www-authenticate") ?? "";
      assert.match(challenge, /^Bearer /);
      assert.match(challenge, /error="invalid_token"/);
      assert.ok(challenge.includes(`resource_metadata="${METADATA_URL}"`), challenge);
      assert.equal(created(), 0);
    } finally {
      await s.stop();
    }
  });

  test("a malformed bearer value is refused like an invalid token", async () => {
    const { s, created } = await counted(false);
    try {
      const res = await post(s, TOOLS_LIST, "not-a-jwt");
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
      assert.equal(created(), 0);
    } finally {
      await s.stop();
    }
  });
});

describe("Requirement: Protected-resource metadata is served per stage", () => {
  for (const [stage, basePath, resource] of [
    ["dev", "/mcp", "https://mcp.dev.a2h.test/mcp"],
    ["pr-12", "/pr-12/mcp", "https://mcp.dev.a2h.test/pr-12/mcp"],
  ] as const) {
    test(`Scenario: Metadata of ${stage === "dev" ? "dev" : "a preview"}: /.well-known/oauth-protected-resource${basePath} without a token`, async () => {
      const s = await start({ stage, mcpBasePath: basePath, auth: auth(false, resource) });
      try {
        const res = await fetch(`${s.origin}/.well-known/oauth-protected-resource${basePath}`);
        assert.equal(res.status, 200);
        const doc = (await res.json()) as Record<string, unknown>;
        assert.equal(doc["resource"], resource);
        assert.deepEqual(doc["authorization_servers"], [as.issuer]);
        assert.deepEqual(doc["scopes_supported"], ["a2h"]);
        assert.deepEqual(doc["bearer_methods_supported"], ["header"]);
        // The resource of another stage is not served here.
        const other = await fetch(`${s.origin}/.well-known/oauth-protected-resource${basePath === "/mcp" ? "/pr-12/mcp" : "/mcp"}`);
        assert.equal(other.status, 404);
        // The authorization server's own metadata is the issuer's, not ours.
        assert.equal((await fetch(`${s.origin}/.well-known/oauth-authorization-server`)).status, 404);
      } finally {
        await s.stop();
      }
    });
  }
});

describe("Requirement: Tokens are verified locally against the authorization server's keys", () => {
  test("a valid token is served: tools/list over the official client", async () => {
    const s = await start({ auth: auth(false) });
    try {
      const client = await connect(`${s.origin}/mcp`, { fetch: withToken(await as.mint()) });
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "find_humans"));
      await client.close();
    } finally {
      await s.stop();
    }
  });

  test("Scenario: Token for another resource (another stage's MCP URL): 401 invalid_token, nothing served", async () => {
    const { s, created } = await counted(false);
    try {
      for (const aud of ["https://mcp.dev.a2h.test/pr-12/mcp", "https://mcp.dev.a2h.test/mcp/", ["https://mcp.a2h.test/mcp"]]) {
        const res = await post(s, TOOLS_LIST, await as.mint({ aud }));
        assert.equal(res.status, 401, JSON.stringify(aud));
        assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
      }
      assert.equal(created(), 0);
    } finally {
      await s.stop();
    }
  });

  test("Scenario: Token from another issuer: signed by an unpublished key, or naming another issuer: 401 invalid_token", async () => {
    const { s, created } = await counted(false);
    try {
      const foreign = await as.mint({}, { key: await as.foreignKey() });
      const foreignKid = await as.mint({}, { key: await as.foreignKey(), kid: "k2" });
      const otherIss = await as.mint({ iss: "https://pr-12.dev.a2h.test/api/auth" });
      for (const token of [foreign, foreignKid, otherIss]) {
        const res = await post(s, TOOLS_LIST, token);
        assert.equal(res.status, 401);
        assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
      }
      assert.equal(created(), 0);
    } finally {
      await s.stop();
    }
  });

  test("Scenario: Missing scope: 403 error=insufficient_scope, scope=a2h", async () => {
    const { s, created } = await counted(false);
    try {
      for (const claims of [{ scope: "offline_access" }, { scope: undefined }, { scope: "a2hx" }]) {
        const res = await post(s, TOOLS_LIST, await as.mint(claims));
        assert.equal(res.status, 403, JSON.stringify(claims));
        const challenge = res.headers.get("www-authenticate") ?? "";
        assert.match(challenge, /error="insufficient_scope"/);
        assert.match(challenge, /scope="a2h"/);
      }
      assert.equal(created(), 0);
    } finally {
      await s.stop();
    }
  });

  test("the scope may come as an `scp` array too", async () => {
    const s = await start({ auth: auth(false) });
    try {
      const res = await post(s, TOOLS_LIST, await as.mint({ scope: undefined, scp: ["a2h"] }));
      assert.equal(res.status, 200);
    } finally {
      await s.stop();
    }
  });

  test("a token without a subject or without an expiry is refused", async () => {
    const s = await start({ auth: auth(false) });
    try {
      for (const claims of [{ sub: undefined }, { exp: undefined }]) {
        const res = await post(s, TOOLS_LIST, await as.mint(claims));
        assert.equal(res.status, 401, JSON.stringify(claims));
      }
    } finally {
      await s.stop();
    }
  });

  test("keys are cached: a second request within a minute fetches no JWKS", async () => {
    const s = await start({ auth: auth(false) });
    try {
      const before = as.jwksFetches();
      assert.equal((await post(s, TOOLS_LIST, await as.mint())).status, 200);
      assert.equal(as.jwksFetches(), before + 1, "first request fetched the keys once");
      assert.equal((await post(s, TOOLS_LIST, await as.mint({ sub: "user-b" }))).status, 200);
      assert.equal((await post(s, TOOLS_LIST, await as.mint())).status, 200);
      assert.equal(as.jwksFetches(), before + 1, "no fetch on later requests");
      // An unknown kid triggers at most one refetch within the cooldown.
      await post(s, TOOLS_LIST, await as.mint({}, { key: await as.foreignKey(), kid: "k9" }));
      await post(s, TOOLS_LIST, await as.mint({}, { key: await as.foreignKey(), kid: "k8" }));
      assert.ok(as.jwksFetches() <= before + 1, `unknown keys refetched within the cooldown: ${as.jwksFetches() - before}`);
    } finally {
      await s.stop();
    }
  });
});

describe("Requirement: Open paths stay open", () => {
  test("Scenario: Health without token: 200, also with the gate on", async () => {
    const s = await start({ auth: auth(false) });
    try {
      assert.equal((await fetch(`${s.origin}/healthz`)).status, 200);
    } finally {
      await s.stop();
    }
  });

  test("PING_OPEN=true: handshake, tools/list and ping without a token; an A2H tool still challenged", async () => {
    const s = await start({ auth: auth(true) });
    try {
      for (const era of ["legacy", "modern"] as const) {
        const client = await connect(`${s.origin}/mcp`, { era });
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((t) => t.name).sort(), ["check_requests", "find_humans", "ping", "request_human"]);
        const pong = await client.callTool({ name: "ping" });
        assert.deepEqual(pong.content, [{ type: "text", text: "pong from stage test" }]);
        await client.close();
      }
      const res = await post(s, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_humans", arguments: { topic: "x" } } });
      assert.equal(res.status, 401);
      // A presented token is always verified, even for ping.
      const bad = await post(s, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } }, "not-a-jwt");
      assert.equal(bad.status, 401);
    } finally {
      await s.stop();
    }
  });

  test("Scenario: Handshake without a token (PING_OPEN=false, prod): 401 challenge, no capabilities", async () => {
    const { s, created } = await counted(false);
    try {
      const res = await post(s, INITIALIZE);
      assert.equal(res.status, 401);
      assert.equal(await res.text(), "");
      const ping = await post(s, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } });
      assert.equal(ping.status, 401);
      assert.equal(created(), 0);
    } finally {
      await s.stop();
    }
  });

  test("AUTH_REQUIRED=false (rollback flag, dev and previews): no gate", async () => {
    const s = await start({ auth: { ...auth(false), required: false } });
    try {
      const client = await connect(`${s.origin}/mcp`);
      assert.ok((await client.listTools()).tools.length === 4);
      await client.close();
    } finally {
      await s.stop();
    }
  });
});
