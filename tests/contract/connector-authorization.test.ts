// Contract tests against a live stage for
// openspec/changes/m1-hosted-connector/specs/platform/connector-authorization/spec.md:
// the MCP endpoint as an OAuth 2.1 resource server. One test per scenario,
// named after it. What the stage's configuration says about its gate comes
// from infra (tests/src/live-env.ts gateExpectation): a scenario that needs
// the gate on is skipped, with the reason, on a stage whose gate is off,
// never passed. The signed-in principal is A2H_TOKEN, the second account
// A2H_TOKEN_2 (tests/lib/obtain-token.ts). Scenarios that are not observable
// from outside (rows, logs) are listed as skipped and point at the
// in-process test that proves them.
// Run: A2H_MCP_URL=https://mcp.dev.<domain>/pr-<n>/mcp A2H_TOKEN=… pnpm --filter @a2h/tests contract
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ProtocolError } from "@modelcontextprotocol/client";
import { generateKeyPair, SignJWT } from "jose";
import { bearerToken, expectedStage, gateExpectation, healthUrl, issuer, mcpUrl, metadataUrl, noScopeToken, secondToken } from "../src/live-env.ts";
import { approvalRound, assertNothingCreatedFor, checkOne, errorOf, grossReserve, listSince, manifest, principalClient, retryLeg, serverNow, texts, type A2hClient } from "./a2h.ts";
import { connectFresh } from "./mcp-client.ts";

const MCP_URL = mcpUrl();
const STAGE = expectedStage(MCP_URL);
const METADATA = metadataUrl(MCP_URL);
const GATE = await gateExpectation(STAGE);
const ISSUER = await issuer(STAGE);
const TOKEN = bearerToken();
const TOKEN_2 = secondToken();
const CHALLENGE = `Bearer resource_metadata="${METADATA.href}", scope="a2h"`;

const MV = "sim-mv-7f3c";
// The can't-tell persona nobody else in the live suites sends to: the request this file creates for
// principal A must not be counted by another file running in parallel (request-flows filters on its own personas).
const NS = "sim-ns-0d39";
const QUESTION = "Would a patient with type 2 diabetes find the insulin section of this leaflet alarming?";

const gateOff = GATE.authRequired ? false : `AUTH_REQUIRED=false on ${STAGE} (infra/service-env.ts): the gate is off by configuration`;
const noTokens = TOKEN && TOKEN_2 ? false : "needs A2H_TOKEN and A2H_TOKEN_2 (tests/lib/obtain-token.ts)";

const RPC = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
const FIND = RPC("tools/call", { name: "find_humans", arguments: { topic: "patient information leaflets", request_type: "judgment" } });

/** A raw POST to the MCP endpoint, with or without a bearer token (the SDK adds nothing here). */
async function post(body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
}

/** A token nobody published a key for: the stage's issuer and audience, any claims, a fresh EdDSA key. */
async function forged(claims: Record<string, unknown> = {}, kid = "forged"): Promise<string> {
  const { privateKey } = await generateKeyPair("EdDSA");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "forged-principal", scope: "a2h offline_access", azp: "forged-client", ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer(typeof claims["iss"] === "string" ? claims["iss"] : ISSUER)
    .setAudience(typeof claims["aud"] === "string" ? claims["aud"] : MCP_URL.href)
    .setIssuedAt(now)
    .setExpirationTime(typeof claims["exp"] === "number" ? claims["exp"] : now + 600)
    .sign(privateKey);
}

function assertInvalidToken(res: Response, what: string): void {
  assert.equal(res.status, 401, `${what}: HTTP ${res.status}`);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /, `${what}: ${challenge}`);
  assert.match(challenge, /error="invalid_token"/, `${what}: ${challenge}`);
  assert.ok(challenge.includes(`resource_metadata="${METADATA.href}"`), `${what}: ${challenge}`);
}

describe("Requirement: Missing or invalid token is challenged", () => {
  test("Scenario: No token: 401, WWW-Authenticate Bearer resource_metadata and scope, empty body", { skip: gateOff }, async () => {
    // With PING_OPEN the handshake, tools/list and ping are admitted by design (D3); an A2H tool is never.
    const res = await post(GATE.pingOpen ? FIND : RPC("tools/list"));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), CHALLENGE);
    assert.equal(await res.text(), "", "the challenge carries no body");
  });

  test("Scenario: Expired token: 401 error=invalid_token with the same resource_metadata", { skip: gateOff }, async () => {
    // A genuine expired token cannot be minted from outside (access tokens live an hour); an
    // expired token nobody published a key for proves the response shape. A2H_EXPIRED_TOKEN, when
    // the caller kept one from an earlier run, is the genuine case. The in-process test with a real
    // expiry: apps/mcp/test/authorization.test.ts "Scenario: Expired token".
    const expired = await forged({ exp: Math.floor(Date.now() / 1000) - 60 });
    assertInvalidToken(await post(RPC("tools/list"), expired), "expired, unpublished key");
    const genuine = process.env["A2H_EXPIRED_TOKEN"]?.trim();
    if (genuine) assertInvalidToken(await post(RPC("tools/list"), genuine), "expired, genuine");
    assertInvalidToken(await post(RPC("tools/list"), "not-a-jwt"), "malformed");
  });
});

describe("Requirement: Protected-resource metadata is served per stage", () => {
  test(`Scenario: Metadata of ${STAGE.startsWith("pr-") ? "a preview" : STAGE}: ${METADATA.pathname} without a token`, async () => {
    const res = await fetch(METADATA, { signal: AbortSignal.timeout(10_000) });
    assert.equal(res.status, 200, `${METADATA.href} -> ${res.status}`);
    const doc = (await res.json()) as Record<string, unknown>;
    assert.equal(doc["resource"], MCP_URL.href.replace(/\/$/, ""), "resource is this stage's MCP URL");
    assert.deepEqual(doc["authorization_servers"], [ISSUER], "the stage's own authorization server, alone");
    assert.deepEqual(doc["scopes_supported"], ["a2h"]);
    assert.deepEqual(doc["bearer_methods_supported"], ["header"]);
    // The authorization server named here serves its own metadata (RFC 8414); the MCP host does not.
    if (process.env["A2H_ISSUER"]) return; // the local stage's test authorization server publishes keys only
    const as = new URL(ISSUER);
    const rfc8414 = await fetch(`${as.origin}/.well-known/oauth-authorization-server${as.pathname}`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(rfc8414.status, 200, "the issuer serves RFC 8414 metadata");
    assert.equal(((await rfc8414.json()) as { issuer?: string }).issuer, ISSUER);
  });
});

describe("Requirement: Tokens are verified locally against the authorization server's keys", () => {
  test("Scenario: Token for another resource: refused with 401 invalid_token (observable part: a token this stage never issued)", { skip: gateOff }, async () => {
    // The stage's authorization server issues tokens for its own resource only (principal-identity
    // "Resource recorded as audience"); a real cross-stage token is tried in preview-environments
    // "Preview tokens stay on the preview". Here: the stage's issuer naming another audience.
    for (const aud of [`${MCP_URL.href.replace(/\/$/, "")}/`, MCP_URL.href.replace(/\/(pr-[0-9]+\/)?mcp\/?$/, "/mcp"), "https://mcp.a2h-protocol.org/mcp"]) {
      if (aud === MCP_URL.href) continue;
      assertInvalidToken(await post(RPC("tools/list"), await forged({ aud })), `aud ${aud}`);
    }
  });

  test("Scenario: Token from another issuer: a key the stage's authorization server never published, even under its current kid", { skip: gateOff }, async () => {
    const jwks = (await (await fetch(`${ISSUER}/jwks`, { signal: AbortSignal.timeout(10_000) })).json()) as { keys: { kid?: string }[] };
    const kid = jwks.keys[0]?.kid ?? "k1";
    assertInvalidToken(await post(RPC("tools/list"), await forged({}, kid)), `forged under the published kid ${kid}`);
    assertInvalidToken(await post(RPC("tools/list"), await forged({ iss: "https://attacker.example/api/auth" })), "another issuer");
    assertInvalidToken(await post(FIND, await forged({})), "an A2H tool call with a forged token");
  });

  test("Scenario: Missing scope: 403 error=insufficient_scope, scope=a2h", { skip: gateOff || (noScopeToken() ? false : "needs A2H_TOKEN_NOSCOPE (the sign-in step mints it when the server grants a scope subset)") }, async () => {
    const res = await post(FIND, noScopeToken());
    assert.equal(res.status, 403, `HTTP ${res.status}`);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /error="insufficient_scope"/, challenge);
    assert.match(challenge, /scope="a2h"/, challenge);
  });

  test("a valid token is served: tools/list and find_humans over the official client", { skip: TOKEN ? false : "needs A2H_TOKEN" }, async () => {
    const { client, close } = await connectFresh();
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "find_humans"));
      const result = await client.callTool({ name: "find_humans", arguments: { topic: "patient information leaflets", request_type: "judgment" } });
      assert.ok(!result.isError, texts(result));
    } finally {
      await close();
    }
  });
});

describe("Requirement: The principal of every tool call is the token's subject", { skip: gateOff || noTokens }, () => {
  let a: A2hClient;
  let b: A2hClient;
  before(async () => {
    a = await principalClient({ token: TOKEN! });
    b = await principalClient({ token: TOKEN_2! });
  });
  after(async () => {
    await a?.close();
    await b?.close();
  });

  /** A request of principal A: the newest this month, or a fresh one to the can't-tell persona (knowledge, gross €18.75) when there is none. */
  async function someRequestOfA(): Promise<string> {
    const now = serverNow();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const existing = await listSince(a, monthStart);
    if (existing[0]) return existing[0].request_id;
    const bid = grossReserve(NS, "knowledge", 20);
    const args = manifest(NS, "knowledge", bid, "Which fungal disease shows as orange pustules on the underside of pear leaves in late summer?");
    const round = await approvalRound(a, args);
    const result = await retryLeg(a, args, round.requestState, { action: "accept", content: { question: String(args["question"]) } });
    assert.ok(!result.isError, texts(result));
    return (result.structuredContent as { request_id: string }).request_id;
  }

  test("Scenario: Request created under the signed-in principal (and request-approval: Principal recorded): another account gets not_found", async () => {
    const id = await someRequestOfA();
    const own = await checkOne(a, id);
    assert.equal(own.request_id, id);
    const other = await b.client.callTool({ name: "check_requests", arguments: { request_id: id } }, { timeout: 30_000 });
    assert.equal(errorOf(other).code, "not_found", "B must see nothing of A's request, not even that it exists");
    assert.ok(!JSON.stringify(other).includes(id), "the id is not echoed back in B's result");
    assert.ok(!JSON.stringify(other).includes(id), "the id is not echoed back in B's result");
    const bList = await listSince(b, new Date(0));
    assert.ok(!bList.some((r) => r.request_id === id), "B's list never holds A's request");
  });

  test("Scenario: Approval state used by another account: -32602 invalid_request_state, nothing created", async () => {
    const since = serverNow();
    const args = manifest(MV, "judgment", 3200, QUESTION);
    const round = await approvalRound(a, args);
    await assert.rejects(
      retryLeg(b, args, round.requestState, { action: "accept", content: { question: QUESTION } }),
      (e: unknown) => {
        assert.ok(e instanceof ProtocolError, `not a JSON-RPC error: ${String(e)}`);
        assert.equal(e.code, -32602);
        assert.equal((e.data as { reason?: string } | undefined)?.reason, "invalid_request_state");
        return true;
      },
    );
    await assertNothingCreatedFor(a, MV, since);
    await assertNothingCreatedFor(b, MV, since);
  });
});

describe("Requirement: Tokens are never forwarded", () => {
  test("Scenario: Token absent from records", { skip: "rows and log lines are not observable from outside; in-process: apps/mcp/test/principals.test.ts \"Scenario: Token absent from records…\" and tests/adversarial/authorization.local.test.ts (token passthrough)" }, () => {});
});

describe("Requirement: Open paths stay open", () => {
  test("Scenario: Health without token: 200", async () => {
    const res = await fetch(healthUrl(MCP_URL), { signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test(`ping without a token: ${GATE.pingOpen ? "admitted (PING_OPEN=true)" : "challenged (PING_OPEN=false)"} as infra configures ${STAGE}`, { skip: gateOff }, async () => {
    const res = await post(RPC("tools/call", { name: "ping" }));
    if (GATE.pingOpen) {
      assert.equal(res.status, 200, `ping must stay open on ${STAGE}`);
      assert.match(await res.text(), /pong from stage/);
    } else {
      assert.equal(res.status, 401, `ping must be challenged on ${STAGE} (PING_OPEN=false)`);
      assert.equal(res.headers.get("www-authenticate"), CHALLENGE);
    }
    // A presented token is always verified, open path or not.
    assertInvalidToken(await post(RPC("tools/call", { name: "ping" }), await forged()), "ping with a forged token");
  });
});
