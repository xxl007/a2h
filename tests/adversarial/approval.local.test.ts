// Adversarial suite, approval side, in-process (m2-approval-page task 6.2):
// the five attacks on the approval of a request, against the real MCP app
// behind its gate (a test authorization server, two principals) and the
// decision the approval page's server action makes (packages/db
// `decideApproval`, design D4), on PostgreSQL 17 in Docker set up as a
// preview. Fail closed expected: nothing reaches a participant that its
// principal did not choose to send on the page, in time, once.
//
//   case 1  approving another principal's request
//   case 2  replaying a decision
//   case 3  forging and guessing tokens
//   case 4  sending after the link has expired
//   case 5  an agent moving a request out of awaiting_approval through MCP
//
// Each case was first run red against a deliberately weakened check (the
// red runs and their weakening are summarised in the PR; nothing weakened is
// committed), then green unpatched. The same attacks run live against a
// preview through the page in approval.live.test.ts (cases 1-3, 5) and
// approval-expiry.live.test.ts (case 4).
//
// Skipped without Docker unless A2H_DB_PG_REQUIRED=1 (CI's `pnpm test`).
// Run: pnpm --filter @a2h/protocol --filter @a2h/db build && pnpm --filter @a2h/tests test
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Client } from "@modelcontextprotocol/client";
import { ProtocolError } from "@modelcontextprotocol/client";
import { decideApproval, type ApprovalOutcome } from "@a2h/db";
import { createApp } from "../../apps/mcp/src/app.ts";
import { openDatabase } from "../../apps/mcp/src/db.ts";
import { callRaw, isInputRequired, modernClient, retry, urlClient } from "../../apps/mcp/test/lib/a2h.ts";
import { startAuthServer, withToken, type TestAuthServer } from "../../apps/mcp/test/lib/auth-server.ts";
import { addPrincipal, rows, skipWithoutDocker, STAGE, startStageDb, type StageDb } from "../../apps/worker/test/lib/stage-db.ts";

const OL = "sim-ol-6a23"; // prompt persona, judgment net 3000 → gross 3750
const A = "user-adversary-a";
const B = "user-adversary-b";
const QUESTION = "Would a patient with type 2 diabetes find the insulin section of this leaflet alarming?";
const FEE_RATE = 0.2;

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    to: OL,
    intent: "judgment",
    audience: "named_individual",
    time_shape: "one_shot",
    format: "single_field",
    question: QUESTION,
    lane: "paid",
    bid_minor: 3800,
    currency: "EUR",
    expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    data_terms: { storage: "principal_workspace", attribution: "attributed", training: "off" },
    ...extra,
  };
}

interface Link {
  id: string;
  token: string;
  url: string;
  expiresAt: Date;
}

describe("adversarial: the approval of a request fails closed (in-process, Postgres in Docker)", { skip: skipWithoutDocker() }, () => {
  let stage: StageDb;
  let as: TestAuthServer;
  let app: ReturnType<typeof createApp> | undefined;
  let database: ReturnType<typeof openDatabase> | undefined;
  let url = "";
  let a: Client;
  let b: Client;
  let tokenA = "";
  let tokenB = "";

  before(async () => {
    stage = await startStageDb();
    await addPrincipal(stage.admin, A, "real_name");
    await addPrincipal(stage.admin, B, "real_name");
    as = await startAuthServer();
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    url = `http://127.0.0.1:${port}/${STAGE}/mcp`;
    database = openDatabase({ connectionString: stage.db.connectionString, schema: stage.db.schema, ssl: false });
    app = createApp({
      stage: STAGE,
      mcpBasePath: `/${STAGE}/mcp`,
      log: () => undefined,
      auth: { required: true, issuer: as.issuer, jwksUrl: as.jwksUrl, resourceUrl: url, pingOpen: false },
      pingMaxConcurrent: 4,
      a2h: { db: database.db, feeRate: FEE_RATE, clearingShare: 0.5, approvalKey: new Uint8Array(32).fill(7), webOrigin: "https://web.a2h.test", limits: { perMinute: 600, perDay: 20000 } },
    });
    await new Promise<void>((r) => app!.server.listen(port, "127.0.0.1", r));
    tokenA = await as.mint({ sub: A, aud: url });
    tokenB = await as.mint({ sub: B, aud: url });
    a = await modernClient(url, undefined, withToken(tokenA));
    b = await modernClient(url, undefined, withToken(tokenB));
  });
  after(async () => {
    await a?.close().catch(() => undefined);
    await b?.close().catch(() => undefined);
    await app?.shutdown(1000).catch(() => undefined);
    await database?.close().catch(() => undefined);
    await as?.stop();
    await stage?.stop();
  });

  /** request_human as `client`: the awaiting request and its link. */
  async function awaiting(client: Client, extra: Record<string, unknown> = {}): Promise<Link> {
    const r = await client.callTool({ name: "request_human", arguments: manifest(extra) });
    assert.equal(r.isError, undefined, JSON.stringify(r).slice(0, 300));
    const out = r.structuredContent as { request_id: string; approval_url: string; approval_expires_at: string };
    const link = new URL(out.approval_url);
    return { id: out.request_id, token: link.searchParams.get("t") ?? "", url: out.approval_url, expiresAt: new Date(out.approval_expires_at) };
  }

  /** What the page's server action does on Send or Don't send (apps/web src/approval/decide.ts). */
  function onPage(link: Pick<Link, "id" | "token">, principal: string, decision: "send" | "dont_send", now = new Date()): Promise<ApprovalOutcome> {
    return decideApproval(database!.db, {
      request_id: link.id,
      token: link.token,
      principal_id: principal,
      now,
      fee_rate: FEE_RATE,
      decision: decision === "send" ? { kind: "send", question: QUESTION } : { kind: "dont_send" },
    });
  }

  async function state(id: string): Promise<{ status: string; reason: string | null; events: string[] }> {
    const [r] = await rows<{ status: string; not_sent_reason: string | null }>(stage.admin, "SELECT status, not_sent_reason FROM requests WHERE id = $1", [id]);
    const ev = await rows<{ to_status: string }>(stage.admin, "SELECT to_status FROM request_events WHERE request_id = $1 ORDER BY at, to_status", [id]);
    return { status: r!.status, reason: r!.not_sent_reason, events: ev.map((e) => e.to_status) };
  }

  const untouched = { status: "awaiting_approval", reason: null, events: ["awaiting_approval"] };

  test("case 1: approving another principal's request → wrong_principal with A's own link, link_invalid with B's token; A's request unchanged and A can still decide", async () => {
    const mine = await awaiting(a);
    const theirs = await awaiting(b);
    for (const decision of ["send", "dont_send"] as const) {
      assert.deepEqual(await onPage(mine, B, decision), { kind: "wrong_principal" }, `B's ${decision} with A's link`);
      // B's own (genuine) token on A's request.
      assert.deepEqual(await onPage({ id: mine.id, token: theirs.token }, B, decision), { kind: "link_invalid" }, `B's ${decision} with B's token on A's request`);
    }
    assert.deepEqual(await state(mine.id), untouched, "A's request moved");
    // B reading it through MCP: not_found, nothing revealed.
    const read = await b.callTool({ name: "check_requests", arguments: { request_id: mine.id } });
    assert.equal((read.structuredContent as { error?: { code: string } }).error?.code, "not_found");
    assert.equal((await onPage(mine, A, "send")).kind, "sent", "the request's own principal still decides");
  });

  test("case 2: replaying a decision → already_decided, no second event, no second hold; concurrent Sends make one transition", async () => {
    const sent = await awaiting(a);
    assert.equal((await onPage(sent, A, "send")).kind, "sent");
    for (const decision of ["send", "dont_send"] as const) {
      const replay = await onPage(sent, A, decision);
      assert.equal(replay.kind, "already_decided", `${decision} replayed on a sent request → ${replay.kind}`);
    }
    assert.deepEqual(await state(sent.id), { status: "sent", reason: null, events: ["awaiting_approval", "sent"] });

    const declined = await awaiting(a);
    assert.equal((await onPage(declined, A, "dont_send")).kind, "not_sent");
    const late = await onPage(declined, A, "send");
    assert.equal(late.kind, "already_decided", `Send after Don't send → ${late.kind}`);
    assert.deepEqual(await state(declined.id), { status: "not_sent", reason: "declined", events: ["awaiting_approval", "not_sent"] });

    const raced = await awaiting(a);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => onPage(raced, A, "send")));
    assert.equal(outcomes.filter((o) => o.kind === "sent").length, 1, `six concurrent Sends: ${JSON.stringify(outcomes.map((o) => o.kind))}`);
    assert.ok(outcomes.every((o) => o.kind === "sent" || o.kind === "already_decided"));
    assert.deepEqual((await state(raced.id)).events, ["awaiting_approval", "sent"]);
  });

  test("case 3: forging and guessing tokens → link_invalid, the same answer as for a request that does not exist; nothing moves", async () => {
    const mine = await awaiting(a);
    const other = await awaiting(a);
    const flipped = mine.token.slice(0, 10) + (mine.token[10] === "A" ? "B" : "A") + mine.token.slice(11);
    const { createHash } = await import("node:crypto");
    const forged = [
      flipped,
      other.token, // a genuine token of another request of the same principal
      `${"A".repeat(42)}A`,
      createHash("sha256").update(mine.token).digest("base64url"), // the stored hash's shape, presented as a token
      "",
      mine.token.slice(0, 42),
      `${mine.token}A`,
      mine.token.toUpperCase(),
      `${mine.token.slice(0, 42)}=`,
      "../../etc/passwd",
    ];
    for (const token of forged) {
      for (const decision of ["send", "dont_send"] as const) {
        assert.deepEqual(await onPage({ id: mine.id, token }, A, decision), { kind: "link_invalid" }, `${decision} with a forged token (${token.length} chars)`);
      }
    }
    // Guessing: well-formed random tokens; none opens the request.
    for (let i = 0; i < 200; i++) {
      const guess = randomBytes(32).toString("base64url");
      assert.deepEqual(await onPage({ id: mine.id, token: guess }, A, "send"), { kind: "link_invalid" }, "a guessed token was accepted");
    }
    // A request id that does not exist gives the same answer (spec "Forged token": the expired page, nothing revealed).
    assert.deepEqual(await onPage({ id: "A2H-0000", token: mine.token }, A, "send"), { kind: "link_invalid" });
    assert.deepEqual(await state(mine.id), untouched, "a forged token moved the request");
    assert.deepEqual(await state(other.id), untouched);
  });

  test("case 4: sending after the link has expired → expired, the request becomes not_sent (expired), never sent; also at the exact expiry and after the platform expired it", async () => {
    const late = await awaiting(a);
    const after1s = new Date(late.expiresAt.getTime() + 1000);
    assert.deepEqual(await onPage(late, A, "send", after1s), { kind: "expired" });
    assert.deepEqual(await state(late.id), { status: "not_sent", reason: "expired", events: ["awaiting_approval", "not_sent"] });
    assert.deepEqual(await onPage(late, A, "send", new Date(after1s.getTime() + 60_000)), { kind: "expired" }, "a second Send after expiry");
    assert.deepEqual(await onPage(late, A, "dont_send", new Date(after1s.getTime() + 60_000)), { kind: "expired" }, "Don't send after expiry");

    const atExpiry = await awaiting(a);
    assert.deepEqual(await onPage(atExpiry, A, "send", atExpiry.expiresAt), { kind: "expired" }, "Send at the exact expiry instant");
    assert.equal((await state(atExpiry.id)).status, "not_sent");

    const justBefore = await awaiting(a);
    assert.equal((await onPage(justBefore, A, "send", new Date(justBefore.expiresAt.getTime() - 1000))).kind, "sent", "a second before expiry still sends (the check is not off by more)");

    // The platform's minute job got there first (apps/worker): the page answers expired, not already decided.
    const byJob = await awaiting(a);
    const { expireApproval } = await import("@a2h/db");
    assert.equal(await expireApproval(database!.db, byJob.id, new Date(byJob.expiresAt.getTime() + 5_000)), true);
    assert.deepEqual(await onPage(byJob, A, "send", new Date(byJob.expiresAt.getTime() + 6_000)), { kind: "expired" });
    assert.deepEqual(await state(byJob.id), { status: "not_sent", reason: "expired", events: ["awaiting_approval", "not_sent"] });
  });

  test("case 5: an agent tries every MCP tool to move a request out of awaiting_approval → nothing sends it; a refusal of the prompt needs the state minted for that request and principal", async () => {
    const target = await awaiting(a);
    const invalidState = (e: unknown) => e instanceof ProtocolError && e.code === -32602;
    const attempts: [string, () => Promise<unknown>][] = [];
    const args = manifest();
    // request_human retries with answers but no state, or with forged and foreign state.
    for (const action of ["accept", "decline", "cancel"] as const) {
      attempts.push([`retry ${action} without state`, () => retry(a, "request_human", args, undefined, { approval: { action } })]);
      attempts.push([`retry ${action} with a forged state`, () => retry(a, "request_human", args, "v1.e30.AAAA", { approval: { action } })]);
    }
    // A URL client's own genuine state for ANOTHER request, presented with this request's id in every field.
    const ua = await urlClient(url, withToken(tokenA));
    const round = await callRaw(ua, "request_human", args);
    assert.ok(isInputRequired(round), "a URL client is asked through URL elicitation");
    const ownOther = round.requestState!;
    attempts.push(["accept with content asking to send", () => retry(ua, "request_human", { ...args, request_id: target.id }, ownOther, { approval: { action: "accept", content: { decision: "send", request_id: target.id } } })]);
    attempts.push(["an unknown input key", () => retry(ua, "request_human", args, ownOther, { send: { action: "accept" }, [target.id]: { action: "accept" } })]);
    // B's state for B's own request, presented by A, and A's by B.
    const ub = await urlClient(url, withToken(tokenB));
    const roundB = await callRaw(ub, "request_human", args);
    assert.ok(isInputRequired(roundB));
    attempts.push(["A presents B's state", () => retry(ua, "request_human", args, roundB.requestState, { approval: { action: "accept" } })]);
    attempts.push(["B presents A's state (decline)", () => retry(ub, "request_human", args, ownOther, { approval: { action: "decline" } })]);
    // Extra arguments that name a status or a decision: the manifest schema is closed.
    for (const extra of [{ request_id: target.id }, { status: "sent" }, { approved: true }, { approval_token: target.token }]) {
      attempts.push([`request_human with ${Object.keys(extra)[0]}`, () => a.callTool({ name: "request_human", arguments: { ...args, ...extra } })]);
    }
    attempts.push(["check_requests by id", () => a.callTool({ name: "check_requests", arguments: { request_id: target.id } })]);
    attempts.push(["check_requests with a status", () => a.callTool({ name: "check_requests", arguments: { request_id: target.id, status: "sent" } })]);
    attempts.push(["find_humans with the link", () => a.callTool({ name: "find_humans", arguments: { topic: target.url.slice(0, 200), request_type: "judgment" } })]);
    attempts.push(["ping", () => a.callTool({ name: "ping", arguments: {} })]);
    attempts.push(["an unknown tool", () => a.callTool({ name: "approve_request", arguments: { request_id: target.id, token: target.token } })]);
    const idOf = (r: typeof round) => new URL((r as { inputRequests?: Record<string, { params: { url?: string } }> }).inputRequests!["approval"]!.params.url!).pathname.split("/").at(-1)!;
    const prompted = [idOf(round), idOf(roundB)];
    for (const [label, attempt] of attempts) {
      try {
        await attempt();
      } catch (e) {
        if (!invalidState(e) && !(e instanceof ProtocolError)) throw new Error(`${label}: ${String(e)}`, { cause: e });
      }
      assert.deepEqual(await state(target.id), untouched, `${label} moved the request`);
      for (const id of prompted) assert.deepEqual(await state(id), untouched, `${label} moved the request of a URL prompt (${id})`);
    }
    // The genuine accept of the URL prompt opens the page and nothing more: still awaiting.
    const accepted = await retry(ua, "request_human", args, ownOther, { approval: { action: "accept" } });
    assert.equal(accepted.isError, undefined, JSON.stringify(accepted).slice(0, 200));
    assert.deepEqual(await state(prompted[0]!), untouched, "accepting the URL prompt moved the request");
    // No tool in tools/list is an approval.
    const names = (await a.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["check_requests", "find_humans", "ping", "request_human"]);
    await ua.close();
    await ub.close();
  });
});
