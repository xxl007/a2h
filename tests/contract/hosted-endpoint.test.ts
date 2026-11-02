// Contract tests against a live stage for
// openspec/changes/m1-hosted-connector/specs/platform/hosted-endpoint/spec.md:
// hostnames and certificates, HTTPS only, the edge limit, the per-principal
// limit and the held-ping cap. The two floods are opt-in (A2H_EDGE_FLOOD=1,
// A2H_RATE_FLOOD=1): they block the caller's address or principal for the
// rest of the window, so they run last and by hand (tests/README.md). The
// limits come from infra/config.ts limitsFor, never from a copy here.
// Run: A2H_MCP_URL=https://mcp.dev.<domain>/pr-<n>/mcp pnpm --filter @a2h/tests contract
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";
import { limitsFor, stageInfo } from "../../infra/config.ts";
import { bearerToken, expectedStage, healthUrl, mcpUrl, webUrl } from "../src/live-env.ts";
import { errorOf, texts } from "./a2h.ts";
import { connectFresh } from "./mcp-client.ts";

const MCP_URL = mcpUrl();
const STAGE = expectedStage(MCP_URL);
const LIMITS = limitsFor(stageInfo(STAGE));
// Previews share dev's load balancer and its web ACL (design D5): the edge limit that applies is dev's.
const EDGE_LIMIT = limitsFor(stageInfo(STAGE.startsWith("pr-") ? "dev" : STAGE)).edgeRequestsPer5Minutes;
const HTTPS = MCP_URL.protocol === "https:";
const noTls = HTTPS ? false : `${MCP_URL.host} is not served over HTTPS (no domain configured)`;

async function certificateOf(host: string): Promise<{ cert: PeerCertificate; authorized: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      const out = { cert, authorized: socket.authorized, ...(socket.authorizationError ? { error: String(socket.authorizationError) } : {}) };
      socket.end();
      resolve(out);
    });
    socket.on("error", reject);
    socket.on("timeout", () => reject(new Error(`TLS handshake with ${host} timed out`)));
  });
}

function assertCertificateFor(host: string, c: { cert: PeerCertificate; authorized: boolean; error?: string }): void {
  assert.equal(c.authorized, true, `${host}: certificate not trusted by Node's root store (${c.error ?? ""})`);
  const sans = (c.cert.subjectaltname ?? "").split(",").map((s) => s.trim().replace(/^DNS:/, ""));
  assert.ok(sans.includes(host), `${host}: not in subjectAltName ${JSON.stringify(sans)}`);
  assert.ok(c.cert.issuer.O, `${host}: issuer has no organisation`);
  assert.notEqual(c.cert.issuer.O, c.cert.subject.O ?? "", `${host}: self-signed`);
  const now = Date.now();
  assert.ok(Date.parse(c.cert.valid_from) <= now && now <= Date.parse(c.cert.valid_to), `${host}: outside the validity window`);
}

describe("Requirement: Stage hostnames under the product domain", () => {
  test(`Scenario: Development hostnames resolve (${STAGE}: the MCP host and the web host present public certificates valid for their names)`, { skip: noTls }, async () => {
    assertCertificateFor(MCP_URL.hostname, await certificateOf(MCP_URL.hostname));
    const web = new URL(await webUrl(STAGE));
    assertCertificateFor(web.hostname, await certificateOf(web.hostname));
    // And they serve what the spec says: the MCP endpoint answers the handshake, the web app a page.
    const { client, close } = await connectFresh();
    try {
      assert.ok(client.getServerCapabilities()?.tools);
    } finally {
      await close();
    }
    const page = await fetch(web, { signal: AbortSignal.timeout(15_000) });
    assert.equal(page.status, 200, `${web.href} -> ${page.status}`);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  });
});

describe("Requirement: HTTPS only", () => {
  test("Scenario: HTTP redirected: 301 to the same URL over HTTPS, and nothing served over HTTP", { skip: noTls }, async () => {
    const plain = new URL(MCP_URL);
    plain.protocol = "http:";
    for (const method of ["GET", "POST"]) {
      const res = await fetch(plain, {
        method,
        redirect: "manual",
        ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(res.status, 301, `${method} ${plain.href} -> ${res.status}`);
      const location = res.headers.get("location") ?? "";
      // The load balancer's redirect action writes the port it was given: ":443" is the same URL.
      assert.ok(location === MCP_URL.href || location === MCP_URL.href.replace("://", "://").replace(MCP_URL.host, `${MCP_URL.host}:443`), `${method}: Location ${location}`);
      const body = await res.text();
      assert.ok(!/pong|jsonrpc|event: message/.test(body), `${method}: content served over plain HTTP: ${body.slice(0, 100)}`);
      assert.ok(body.length < 1_000, `${method}: more than redirect boilerplate over HTTP (${body.length} bytes)`);
    }
  });
});

describe("Requirement: Edge rate limit per source address", () => {
  test(`Scenario: Flood from one address (opt-in A2H_EDGE_FLOOD=1; ${EDGE_LIMIT} requests per 5 minutes from this address get 429 after the limit, health keeps answering 200)`, { skip: process.env["A2H_EDGE_FLOOD"] === "1" ? false : "opt-in: blocks this address on the MCP and auth paths for the rest of the window; run by hand, last (task 8.4)", timeout: 10 * 60_000 }, async () => {
    // Unauthenticated POSTs to the MCP path: cheap for the service (a 401 or, gate off, a tool
    // list), counted by the WAF rule, never by the per-principal limiter.
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const one = async (): Promise<number> => {
      try {
        const res = await fetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body, signal: AbortSignal.timeout(15_000) });
        await res.arrayBuffer();
        return res.status;
      } catch {
        return 0;
      }
    };
    const health = async (): Promise<number> => {
      const res = await fetch(healthUrl(MCP_URL), { signal: AbortSignal.timeout(10_000) });
      await res.arrayBuffer();
      return res.status;
    };
    const statuses = new Map<number, number>();
    const bump = (s: number) => statuses.set(s, (statuses.get(s) ?? 0) + 1);
    const total = EDGE_LIMIT + Math.ceil(EDGE_LIMIT / 10);
    const concurrency = 50;
    let sent = 0;
    let healthFailures = 0;
    const started = Date.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (sent < total) {
          sent += 1;
          bump(await one());
          if (sent % 200 === 0 && (await health()) !== 200) healthFailures += 1;
        }
      }),
    );
    const floodMs = Date.now() - started;
    // WAF evaluates the rate on a sliding window and may take a moment to start blocking: keep probing.
    const deadline = Date.now() + 120_000;
    let blocked = statuses.get(429) ?? 0;
    while (blocked === 0 && Date.now() < deadline) {
      for (let i = 0; i < 20; i++) {
        const s = await one();
        bump(s);
        if (s === 429) blocked += 1;
      }
      if ((await health()) !== 200) healthFailures += 1;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    const summary = `sent ${total} in ${Math.round(floodMs / 1000)} s; statuses ${JSON.stringify(Object.fromEntries(statuses))}; health failures ${healthFailures}`;
    process.stdout.write(`edge flood (${STAGE}, limit ${EDGE_LIMIT}): ${summary}\n`);
    assert.ok(blocked > 0, `no 429 after exceeding the edge limit: ${summary}`);
    assert.equal(healthFailures, 0, `health was limited during the flood: ${summary}`);
    assert.equal(await health(), 200, "health still answers after the flood");
    const after = await fetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body, signal: AbortSignal.timeout(15_000) });
    assert.equal(after.status, 429, `the address stays blocked for the rest of the window (got ${after.status})`);
  });
});

describe("Requirement: Per-principal tool-call limit", () => {
  test(`Scenario: Minute limit reached (opt-in A2H_RATE_FLOOD=1; ${LIMITS.perMinute} calls a minute on ${STAGE}): rate_limited with retry_after_seconds, nothing created`, { skip: process.env["A2H_RATE_FLOOD"] === "1" ? (bearerToken() ? false : "needs A2H_TOKEN") : "opt-in: exhausts the signed-in principal's minute; run by hand, last", timeout: 5 * 60_000 }, async () => {
    const { client, close } = await connectFresh({ timeout: 30_000 });
    try {
      const find = () => client.callTool({ name: "find_humans", arguments: { topic: "patient information leaflets", request_type: "judgment" } }, { timeout: 30_000 });
      let limited: ReturnType<typeof errorOf> | undefined;
      let calls = 0;
      const total = LIMITS.perMinute + 5;
      const started = Date.now();
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          while (calls < total && !limited) {
            calls += 1;
            const r = await find();
            if (r.isError) {
              const e = errorOf(r);
              if (e.code === "rate_limited") limited = e;
              else throw new Error(`unexpected refusal ${e.code}: ${texts(r)}`);
            }
          }
        }),
      );
      assert.ok(Date.now() - started < 60_000, "the calls did not fit in one minute; the limit was never reached");
      assert.ok(limited, `no rate_limited result after ${calls} calls (limit ${LIMITS.perMinute})`);
      assert.equal(limited.stage, "throttle");
      assert.equal(limited.retryable, true);
      const retry = (limited as { details?: { retry_after_seconds?: number } }).details?.retry_after_seconds;
      assert.ok(typeof retry === "number" && retry >= 1 && retry <= 60, `retry_after_seconds ${String(retry)}`);
      // The next call within the minute is refused the same way; find_humans creates nothing anyway.
      assert.equal(errorOf(await find()).code, "rate_limited");
    } finally {
      await close();
    }
  });

  test("Scenario: Limit shared across instances", { skip: "a preview runs one MCP task; in-process: apps/mcp/test/principals.test.ts \"Scenario: Limit shared across instances\" (two servers, one schema), packages/db/test/principals.test.ts" }, () => {});
});

describe("Requirement: Held connections are capped", () => {
  test(`Scenario: Cap reached (${LIMITS.pingMaxConcurrent} held pings per instance): the next held ping is refused at once with rate_limited, the held ones complete`, { timeout: 60_000 }, async () => {
    const cap = LIMITS.pingMaxConcurrent;
    const hold = 8;
    const clients = await Promise.all(Array.from({ length: cap + 1 }, () => connectFresh({ timeout: 30_000 })));
    try {
      const held = clients.slice(0, cap).map((c) => c.client.callTool({ name: "ping", arguments: { holdSeconds: hold } }, { timeout: (hold + 20) * 1000 }));
      // Give the held calls time to be admitted before the extra one arrives.
      await new Promise((r) => setTimeout(r, 1_500));
      const started = Date.now();
      const extra = await clients[cap]!.client.callTool({ name: "ping", arguments: { holdSeconds: hold } }, { timeout: 30_000 });
      const elapsed = Date.now() - started;
      const e = errorOf(extra);
      assert.equal(e.code, "rate_limited", `the ${cap + 1}th held ping: ${texts(extra)}`);
      assert.ok(elapsed < 3_000, `refused at once, not queued (took ${elapsed} ms)`);
      const results = await Promise.all(held);
      for (const [i, r] of results.entries()) {
        assert.ok(!r.isError, `held ping ${i + 1} failed: ${texts(r)}`);
        assert.match(texts(r), /^pong/, `held ping ${i + 1}`);
      }
      // An instant ping is never refused by the cap, and a hold is accepted again afterwards.
      const instant = await clients[cap]!.client.callTool({ name: "ping" }, { timeout: 30_000 });
      assert.ok(!instant.isError, texts(instant));
      const again = await clients[cap]!.client.callTool({ name: "ping", arguments: { holdSeconds: 1 } }, { timeout: 30_000 });
      assert.ok(!again.isError, texts(again));
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });
});
