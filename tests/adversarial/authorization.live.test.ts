// Adversarial suite, authorization side, against a live stage (m1-hosted-connector
// task 9.2; protocol skill §12 cases that concern authorization). Fail closed
// expected: a token the stage did not issue for this resource is never
// served, an approval state never crosses accounts, a token-shaped argument
// is never echoed, one principal never reads another's requests, and client
// registration cannot be flooded. Each case was first shown red against a
// weakened verifier on the local stage (tests/local/stage.ts with
// A2H_LOCAL_AUTH=1; the red-run log is kept outside the repository, its
// summary is in the PR), then green unpatched and on the preview.
//
// Needs A2H_TOKEN and A2H_TOKEN_2 (two principals) for the cross-account
// cases; the token-forgery cases need only the gate on. Scenarios this file
// cannot observe from outside are in authorization.local.test.ts.
// Run: A2H_MCP_URL=… A2H_WEB_URL=… A2H_TOKEN=… A2H_TOKEN_2=… pnpm --filter @a2h/tests adversarial
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ProtocolError } from "@modelcontextprotocol/client";
import { generateKeyPair, SignJWT } from "jose";
import { bearerToken, devGate, devMcpUrl, expectedStage, gateExpectation, issuer, mcpUrl, metadataUrl, secondToken, webUrl } from "../src/live-env.ts";
import { registerClient } from "../lib/oauth-client.ts";
import {
  accept,
  approvalRound,
  assertNothingCreatedFor,
  checkOne,
  errorOf,
  firstLeg,
  isInputRequired,
  listSince,
  manifest,
  principalClient,
  retryLeg,
  serverNow,
  texts,
  type A2hClient,
} from "../contract/a2h.ts";

const MCP_URL = mcpUrl();
const STAGE = expectedStage(MCP_URL);
const RESOURCE = MCP_URL.href.replace(/\/$/, "");
const METADATA = metadataUrl(MCP_URL).href;
const GATE = await gateExpectation(STAGE);
const ISSUER = await issuer(STAGE);
const TOKEN = bearerToken();
const TOKEN_2 = secondToken();

const gateOff = GATE.authRequired ? false : `AUTH_REQUIRED=false on ${STAGE} (infra/service-env.ts): the gate is off by configuration`;
const noTokens = TOKEN && TOKEN_2 ? false : "needs A2H_TOKEN and A2H_TOKEN_2";
// Case A2 presents this preview's token to dev: observable only once dev (main) runs the gate.
const DEV_GATE = STAGE.startsWith("pr-") && !gateOff ? await devGate() : { on: false as const, reason: "runs from a preview against dev" };

const MV = "sim-mv-7f3c";
const TH = "sim-th-2a91";
const BENIGN = "Would a patient with type 2 diabetes find the insulin section of this leaflet alarming?";

const RPC = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
const LIST = RPC("tools/call", { name: "check_requests", arguments: {} });

async function post(url: URL, body: unknown, token: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

/** Signs `claims` with a key nobody published; defaults name this stage's issuer and resource. */
async function forged(claims: Record<string, unknown> = {}, header: { kid?: string; alg?: "EdDSA" | "ES256" } = {}): Promise<string> {
  const alg = header.alg ?? "EdDSA";
  const { privateKey } = await generateKeyPair(alg);
  const now = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = { sub: "attacker", scope: "a2h offline_access", azp: "attacker-client", iss: ISSUER, aud: RESOURCE, iat: now, exp: now + 600, ...claims };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  return new SignJWT(body).setProtectedHeader({ alg, kid: header.kid ?? "attacker" }).sign(privateKey);
}

function refused(res: Response, what: string): void {
  assert.equal(res.status, 401, `${what}: HTTP ${res.status}`);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /error="invalid_token"/, `${what}: ${challenge}`);
  assert.ok(challenge.includes(`resource_metadata="${METADATA}"`), `${what}: ${challenge}`);
}

/** Changes one claim of a real token without re-signing: the signature no longer covers the payload. */
function tampered(token: string, patch: Record<string, unknown>): string {
  const [h, p, s] = token.split(".");
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>;
  return `${h}.${Buffer.from(JSON.stringify({ ...payload, ...patch })).toString("base64url")}.${s}`;
}

describe("adversarial: tokens the stage did not issue for this resource (live)", { skip: gateOff }, () => {
  test("case A1: token for another resource → 401 invalid_token, nothing served (forged audiences; the real cross-stage token in A2 below)", async () => {
    const dev = (await devMcpUrl()).href;
    for (const aud of [`${RESOURCE}/`, RESOURCE.toUpperCase(), dev === RESOURCE ? "https://mcp.a2h-protocol.org/mcp" : dev, [RESOURCE, "https://other.example/mcp"].join(" "), ["https://other.example/mcp"]]) {
      refused(await post(MCP_URL, LIST, await forged({ aud })), `aud ${JSON.stringify(aud)}`);
    }
    if (TOKEN) {
      // A genuine token with its audience rewritten: the signature no longer verifies.
      refused(await post(MCP_URL, LIST, tampered(TOKEN, { aud: "https://other.example/mcp" })), "genuine token, audience rewritten");
    }
    // A token the stage's own authorization server signed for another resource (the local stage mints one;
    // a deployed stage never issues one, see A2): the audience check alone must refuse it.
    const otherAud = process.env["A2H_TOKEN_OTHER_AUD"]?.trim();
    if (otherAud) refused(await post(MCP_URL, LIST, otherAud), "genuinely signed, another audience");
  });

  test("case A2: this stage's token presented to the other stage (preview → dev) → refused there", { skip: (DEV_GATE.on ? false : DEV_GATE.reason) || (TOKEN ? false : "needs A2H_TOKEN") }, async () => {
    const dev = await devMcpUrl();
    const res = await post(dev, LIST, TOKEN!);
    assert.equal(res.status, 401, `dev served a preview token: ${res.status}`);
    assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  });

  test("case A3: token from another issuer → 401 (unpublished key under the stage's own kid, ES256 instead of EdDSA, another iss, alg none)", async () => {
    const jwks = (await (await fetch(`${ISSUER}/jwks`, { signal: AbortSignal.timeout(10_000) })).json()) as { keys: { kid?: string }[] };
    const kid = jwks.keys[0]?.kid ?? "k1";
    refused(await post(MCP_URL, LIST, await forged({}, { kid })), `forged under published kid ${kid}`);
    refused(await post(MCP_URL, LIST, await forged({}, { kid, alg: "ES256" })), "ES256 under the published kid");
    refused(await post(MCP_URL, LIST, await forged({ iss: "https://attacker.example/api/auth" })), "another issuer");
    refused(await post(MCP_URL, LIST, await forged({ iss: `${ISSUER}/` })), "issuer with a trailing slash");
    // alg none: header says unsigned, payload names everything right.
    const now = Math.floor(Date.now() / 1000);
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "attacker", scope: "a2h", iss: ISSUER, aud: RESOURCE, iat: now, exp: now + 600 })).toString("base64url")}.`;
    refused(await post(MCP_URL, LIST, none), "alg none");
    if (TOKEN) refused(await post(MCP_URL, LIST, tampered(TOKEN, { sub: "someone-else" })), "genuine token, subject rewritten");
  });

  test("case A4: expired token → 401 (expired and signed by an unpublished key; a genuine token with exp rewritten; A2H_EXPIRED_TOKEN when kept)", async () => {
    const now = Math.floor(Date.now() / 1000);
    refused(await post(MCP_URL, LIST, await forged({ exp: now - 1 })), "expired a second ago");
    refused(await post(MCP_URL, LIST, await forged({ exp: now - 86_400 })), "expired a day ago");
    refused(await post(MCP_URL, LIST, await forged({ exp: undefined })), "no expiry at all");
    if (TOKEN) refused(await post(MCP_URL, LIST, tampered(TOKEN, { exp: now + 10 * 365 * 86_400 })), "genuine token, expiry extended");
    const genuine = process.env["A2H_EXPIRED_TOKEN"]?.trim();
    if (genuine) refused(await post(MCP_URL, LIST, genuine), "a genuine expired token");
  });
});

describe("adversarial: accounts do not mix (live)", { skip: gateOff || noTokens }, () => {
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

  test("case A5: forged state across accounts → -32602 invalid_request_state, nothing created (B redeems A's approval; A's state with B's arguments; B's own state after A's)", async () => {
    const since = serverNow();
    const args = manifest(MV, "judgment", 3200, BENIGN);
    const roundA = await approvalRound(a, args);
    const invalidState = (e: unknown) => {
      assert.ok(e instanceof ProtocolError, `not a JSON-RPC error: ${String(e)}`);
      assert.equal(e.code, -32602);
      assert.equal((e.data as { reason?: string } | undefined)?.reason, "invalid_request_state");
      return true;
    };
    await assert.rejects(retryLeg(b, args, roundA.requestState, accept(BENIGN)), invalidState, "B redeems A's state");
    await assert.rejects(retryLeg(b, manifest(TH, "knowledge", 6000, BENIGN), roundA.requestState, accept(BENIGN)), invalidState, "B redeems A's state with other arguments");
    // B's own approval still works for B (the gate did not break B), and A's state is still A's.
    const roundB = await approvalRound(b, args);
    await assert.rejects(retryLeg(a, args, roundB.requestState, accept(BENIGN)), invalidState, "A redeems B's state");
    const declined = await retryLeg(b, args, roundB.requestState, { action: "decline" });
    assert.ok(!declined.isError, texts(declined));
    await assertNothingCreatedFor(a, MV, since);
    await assertNothingCreatedFor(b, MV, since);
    await assertNothingCreatedFor(b, TH, since);
  });

  test("case A6: token passthrough attempt → a token-shaped argument is never echoed back; the tools work on text, not credentials", async () => {
    const since = serverNow();
    const token = TOKEN!;
    const looksLikeToken = (s: string) => {
      for (let i = 0; i + 16 <= token.length; i += 8) if (s.includes(token.slice(i, i + 16))) return true;
      return false;
    };
    // find_humans with the token's tail as the topic (`topic` is at most 200 characters): a result, never the token.
    const found = await a.client.callTool({ name: "find_humans", arguments: { topic: `Bearer ${token.slice(-120)}`, request_type: "judgment" } }, { timeout: 30_000 });
    assert.ok(!found.isError, `find_humans refused a token-shaped topic instead of searching: ${texts(found)}`);
    assert.ok(!looksLikeToken(JSON.stringify(found)), "find_humans echoed a piece of the token");
    const refusedLong = await a.client.callTool({ name: "find_humans", arguments: { topic: `Bearer ${token}`, request_type: "judgment" } }, { timeout: 30_000 });
    assert.ok(!looksLikeToken(JSON.stringify(refusedLong)), "the schema refusal echoed the token");
    // request_human with the token inside the question: the approval shows the question (by design) and the
    // request is declined; the refusal and listing paths never carry the token elsewhere.
    const args = manifest(MV, "judgment", 3200, `${BENIGN} Authorization: Bearer ${token}`);
    const round = await firstLeg(a, args);
    if (isInputRequired(round)) {
      const declined = await retryLeg(a, args, round.requestState, { action: "decline" });
      assert.ok(!declined.isError, texts(declined));
      assert.ok(!looksLikeToken(JSON.stringify(declined)), "the decline result echoed the token");
    } else {
      assert.ok(!looksLikeToken(JSON.stringify(round)), "the refusal echoed the token");
    }
    // check_requests with the token as an id: not_found, nothing echoed.
    const checked = await a.client.callTool({ name: "check_requests", arguments: { request_id: token.slice(0, 8) } }, { timeout: 30_000 });
    assert.ok(!looksLikeToken(JSON.stringify(checked)));
    await assertNothingCreatedFor(a, MV, since);
  });

  test("case A7: a second principal reading another's requests → not_found by id, absent from every list and filter", async () => {
    const now = serverNow();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const ownA = await listSince(a, monthStart);
    const ownB = await listSince(b, monthStart);
    const idsB = new Set(ownB.map((r) => r.request_id));
    assert.ok(!ownA.some((r) => idsB.has(r.request_id)), "a request appears in both principals' lists");
    for (const r of ownA.slice(0, 5)) {
      const byId = await b.client.callTool({ name: "check_requests", arguments: { request_id: r.request_id } }, { timeout: 30_000 });
      assert.equal(errorOf(byId).code, "not_found", `B read A's ${r.request_id}`);
      for (const status of ["sent", "accepted", "answered", "declined", "expired"]) {
        const filtered = await listSince(b, monthStart, status);
        assert.ok(!filtered.some((x) => x.request_id === r.request_id), `B's ${status} filter lists A's ${r.request_id}`);
      }
      // A still sees it.
      assert.equal((await checkOne(a, r.request_id)).request_id, r.request_id);
    }
    if (ownA.length === 0) process.stdout.write("case A7: principal A has no request this month on this stage; the by-id checks did not run\n");
  });
});

describe("adversarial: client registration flood (live)", () => {
  test("case A8: DCR flood → 429 within ten rapid registrations from one address, with a retry hint", { skip: process.env["A2H_ISSUER"] ? "the local stage's test authorization server has no registration endpoint; runs against a deployed stage or a local next start" : false, timeout: 60_000 }, async () => {
    const iss = await issuer(STAGE);
    void (await webUrl(STAGE));
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 10 && !statuses.includes(429); i++) {
      const r = await registerClient(iss, `A2H QA flood ${Date.now()}-${i}`);
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get("x-retry-after") ?? r.headers.get("retry-after");
    }
    process.stdout.write(`case A8: registration statuses ${JSON.stringify(statuses)}\n`);
    assert.ok(statuses.includes(429), `no 429 in ${statuses.length} rapid registrations: ${JSON.stringify(statuses)}`);
    assert.ok(retryAfter !== null, "the 429 carries a retry hint header");
    assert.ok(statuses.filter((s) => s === 201).length <= 5, "more than five registrations succeeded within a minute");
  });
});
