// Task 4.4: check_requests, one test per display scenario of
// openspec/changes/archive/2026-10-29-m1-protocol-connector/specs/protocol/request-lifecycle and
// .../protocol/answer-attestation; m2-approval-page task 3.2: "Awaiting
// approval" and "Not sent" (requests are sent through the page's shared
// decision, `approveOnPage`). The worker's transitions are simulated by
// writing the rows it writes (events, answer, cleared amount); the answer is
// a real Ed25519 envelope signed with the protocol package.
import type { webcrypto } from "node:crypto";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  CheckRequestsOutputSchema,
  RequestHumanOutputSchema,
  canonicalAnswerPayload,
  importPrivateKey,
  signAnswer,
  type CheckedRequest,
  type UnsignedAnswer,
} from "@a2h/protocol";
import type { DbConfig } from "../src/config.ts";
import { freshSchema, skipWithoutDocker, sqlIn, startPostgres, type PgContainer } from "./lib/db.ts";
import { NOW, TEST_PRINCIPAL, TEST_WEB_ORIGIN, approveOnPage, modernClient, startA2h, texts, urlClient, type RunningA2h } from "./lib/a2h.ts";
import { BASE } from "./lib/fixtures.ts";

const ANSWER_TEXT = "The dosage table reads as a warning; the rest is calm.";

interface Key {
  key_id: string;
  public_key: string;
  sign: (a: UnsignedAnswer) => Promise<string>;
}

async function newKey(keyId: string): Promise<Key> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privateKey = await importPrivateKey(pkcs8);
  return { key_id: keyId, public_key: Buffer.from(raw).toString("base64"), sign: (a) => signAnswer(a, privateKey) };
}

describe("check_requests", { skip: skipWithoutDocker() }, () => {
  let pgc: PgContainer;
  let db: DbConfig;
  let server: RunningA2h;
  let key: Key;

  before(async () => {
    pgc = await startPostgres();
    db = await freshSchema(pgc);
    server = await startA2h(db);
    key = await newKey("a2h-test-0000000000000001");
    await sqlIn(db, "INSERT INTO signing_keys (key_id, public_key, status) VALUES ($1, $2, 'active')", [key.key_id, key.public_key]);
  });
  after(async () => {
    await server?.stop();
    pgc?.stop();
  });

  /** request_human, then the link's approval; the awaiting result. */
  async function ask(args: Record<string, unknown> = BASE) {
    const client = await modernClient(server.url);
    try {
      const result = await client.callTool({ name: "request_human", arguments: args });
      assert.ok(!result.isError, texts(result).join(" | "));
      const out = RequestHumanOutputSchema.parse(result.structuredContent);
      assert.equal(out.status, "awaiting_approval");
      return out as { request_id: string; approval_url: string; approval_expires_at: string };
    } finally {
      await client.close();
    }
  }

  async function send(args: Record<string, unknown> = BASE): Promise<string> {
    const out = await ask(args);
    assert.equal((await approveOnPage(db, out.approval_url)).kind, "sent");
    return out.request_id;
  }

  /** What the worker writes on a transition: the status and its event, together. */
  async function transition(id: string, from: string, to: string, actor: string, at: string): Promise<void> {
    await sqlIn(db, "UPDATE requests SET status = $2, updated_at = $3 WHERE id = $1", [id, to, at]);
    await sqlIn(db, "INSERT INTO request_events (request_id, from_status, to_status, actor, at) VALUES ($1, $2, $3, $4, $5)", [id, from, to, actor, at]);
  }

  async function answer(id: string, signedAt: string, k: Key = key, cleared = 3163): Promise<UnsignedAnswer & { key_id: string; signature: string }> {
    await transition(id, "sent", "accepted", "participant", "2026-10-27T09:05:00Z");
    const unsigned: UnsignedAnswer = {
      request_id: id,
      participant_id: "p_sim_mv_7f3c",
      body: { verdict: "yes", note: { text: ANSWER_TEXT } },
      confidence: 4,
      answered_personally: true,
      signed_at: signedAt,
    };
    const signature = await k.sign(unsigned);
    await sqlIn(
      db,
      `INSERT INTO answers (request_id, participant_id, body, confidence, answered_personally, signed_at, key_id, signature)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7)`,
      [id, unsigned.participant_id, JSON.stringify(unsigned.body), 4, signedAt, k.key_id, signature],
    );
    await sqlIn(db, "UPDATE requests SET status = 'answered', cleared_minor = $2, updated_at = now() WHERE id = $1", [id, cleared]);
    await sqlIn(db, "INSERT INTO request_events (request_id, from_status, to_status, actor, at) VALUES ($1, 'accepted', 'answered', 'participant', '2026-10-27T09:20:00Z')", [id]);
    return { ...unsigned, key_id: k.key_id, signature };
  }

  async function check(args: Record<string, unknown>): Promise<{ result: CallToolResult; requests: CheckedRequest[] }> {
    const client = await modernClient(server.url);
    try {
      const result = (await client.callTool({ name: "check_requests", arguments: args }));
      if (result.isError) return { result, requests: [] };
      return { result, requests: CheckRequestsOutputSchema.parse(result.structuredContent).requests };
    } finally {
      await client.close();
    }
  }

  test("Scenario: Before acceptance: the handle and no display label", async () => {
    const id = await send();
    const { result, requests } = await check({ request_id: id });
    assert.equal(requests.length, 1);
    const r = requests[0]!;
    assert.equal(r.status, "sent");
    assert.equal(r.handle, "sim-mv-7f3c");
    assert.equal(r.participant_label, undefined);
    assert.equal(r.identity_verified, undefined);
    assert.equal(r.simulated, true);
    assert.equal(r.held_minor, 3200);
    assert.equal(r.hold_status, "held");
    assert.equal(new Date(r.transitions.sent_at!).toISOString(), "2026-10-27T09:00:00.000Z");
    assert.ok(!JSON.stringify(result).includes("Margaret") && !JSON.stringify(result).includes("Vale"), "no name before acceptance");
  });

  test("Scenario: After acceptance: the display label and whether the participant is identity-verified", async () => {
    const id = await send();
    await transition(id, "sent", "accepted", "participant", "2026-10-27T09:05:00Z");
    const { result, requests } = await check({ request_id: id });
    const r = requests[0]!;
    assert.equal(r.status, "accepted");
    assert.equal(r.participant_label, "Margaret Vale (simulated)");
    assert.equal(r.identity_verified, true);
    assert.equal(new Date(r.transitions.accepted_at!).toISOString(), "2026-10-27T09:05:00.000Z");
    assert.match(texts(result).join("\n"), /Margaret Vale \(simulated\)/);
  });

  test("Scenario: Answered request: the envelope (body, confidence, attestation, signed time, key id, signature) and the cleared amount", async () => {
    const id = await send();
    const envelope = await answer(id, "2026-10-27T11:10:00+02:00");
    const { result, requests } = await check({ request_id: id });
    const r = requests[0]!;
    assert.equal(r.status, "answered");
    assert.deepEqual(r.answer, envelope);
    assert.equal(canonicalAnswerPayload(r.answer), canonicalAnswerPayload(envelope), "the envelope is returned exactly as signed");
    assert.equal(r.cleared_minor, 3163);
    assert.equal(r.hold_status, "captured");
    assert.equal(r.simulated, true, "Marked in answers: simulated: true");
    const text = texts(result).join("\n");
    assert.match(text, /answered personally/i);
    assert.match(text, /4\/5/);
    assert.match(text, new RegExp(ANSWER_TEXT.replace(/[.;]/g, ".")));
    assert.match(text, /€31\.63/);
    assert.match(text, /human/i);
  });

  test("Scenario: Display of the reference answer: signature display, reviewed by M.V., 21 Oct 2026, verification notice when applicable", async () => {
    const id = await send();
    const envelope = await answer(id, "2026-10-21T09:10:00+02:00");
    const verified = (await check({ request_id: id })).requests[0]!;
    assert.equal(verified.answer_display!.signature, `a2h:sig:…${envelope.signature.slice(-4)}`);
    assert.equal(verified.answer_display!.citation, "reviewed by M.V., 21 Oct 2026");
    assert.equal(verified.answer_display!.verification_notice, undefined, "no notice for a verified participant");

    await sqlIn(db, "UPDATE participants SET identity_verified = false WHERE id = 'p_sim_mv_7f3c'");
    try {
      const { result, requests } = await check({ request_id: id });
      const r = requests[0]!;
      assert.equal(r.identity_verified, false);
      assert.match(r.answer_display!.verification_notice ?? "", /not yet (identity-)?verified/i);
      const text = texts(result).join("\n");
      assert.match(text, /reviewed by M\.V\., 21 Oct 2026/);
      assert.match(text, /a2h:sig:…/);
      assert.match(text, /not yet (identity-)?verified/i);
    } finally {
      await sqlIn(db, "UPDATE participants SET identity_verified = true WHERE id = 'p_sim_mv_7f3c'");
    }
  });

  test("Scenario: Filter by status: every returned request is sent and belongs to the calling principal", async () => {
    const mine = await send();
    const other = await startA2h(db, { principal: { ...TEST_PRINCIPAL, principal_id: "another-principal" } });
    try {
      const client = await modernClient(other.url, (p) => ({ action: "accept", content: { question: String(p.requestedSchema.properties["question"]?.["default"]) } }));
      await client.callTool({ name: "request_human", arguments: BASE });
      await client.close();
      const { requests } = await check({ status: "sent" });
      assert.ok(requests.some((r) => r.request_id === mine));
      for (const r of requests) assert.equal(r.status, "sent");
      const own = await sqlIn<{ id: string }>(db, "SELECT id FROM requests WHERE principal_id = $1 AND status = 'sent'", [TEST_PRINCIPAL.principal_id]);
      assert.deepEqual(requests.map((r) => r.request_id).sort(), own.map((o) => o.id).sort(), "exactly the caller's sent requests");
      const limited = await check({ status: "sent", limit: 1 });
      assert.equal(limited.requests.length, 1);
      const later = await check({ since: "2030-01-01T00:00:00Z" });
      assert.deepEqual(later.requests, []);
    } finally {
      await other.stop();
    }
  });

  test("Scenario: Awaiting approval: the approval link, its expiry and no held amount", async () => {
    const out = await ask();
    const { result, requests } = await check({ request_id: out.request_id });
    const r = requests[0]!;
    assert.equal(r.status, "awaiting_approval");
    assert.equal(r.approval_url, out.approval_url, "the same link as request_human gave");
    assert.equal(new URL(r.approval_url).origin, TEST_WEB_ORIGIN);
    assert.equal(r.approval_expires_at, out.approval_expires_at);
    assert.equal(r.held_minor, undefined);
    assert.equal(r.hold_status, "none");
    assert.equal(r.transitions.sent_at, undefined);
    assert.equal(new Date(r.transitions.awaiting_approval_at!).toISOString(), NOW.toISOString());
    const text = texts(result).join("\n");
    assert.ok(text.includes(out.approval_url));
    assert.match(text, /awaiting approval/i);
    assert.match(text, /nothing held/i);
    // In a list too, filtered by the new status.
    const listed = (await check({ status: "awaiting_approval" })).requests;
    assert.ok(listed.some((x) => x.request_id === out.request_id && x.approval_url === out.approval_url));
  });

  test("Scenario: Not sent: status not_sent, the reason declined or expired, and no held amount", async () => {
    // declined on the page
    const declined = await ask();
    assert.equal((await approveOnPage(db, declined.approval_url, { decision: "dont_send" })).kind, "not_sent");
    // declined by dismissing the URL elicitation
    const client = await urlClient(server.url);
    let dismissed: string;
    try {
      const round = (await client.callTool({ name: "request_human", arguments: BASE }, { allowInputRequired: true })) as unknown as { inputRequests: Record<string, unknown>; requestState: string };
      const key = Object.keys(round.inputRequests)[0]!;
      const done = await client.callTool({ name: "request_human", arguments: BASE, inputResponses: { [key]: { action: "cancel" } }, requestState: round.requestState } as never, { allowInputRequired: true });
      dismissed = RequestHumanOutputSchema.parse(done.structuredContent).request_id;
    } finally {
      await client.close();
    }
    // expired link
    const expired = await ask();
    await sqlIn(db, "UPDATE requests SET status = 'not_sent', not_sent_reason = 'expired', updated_at = $2 WHERE id = $1", [expired.request_id, "2026-10-28T09:00:00Z"]);
    await sqlIn(db, "INSERT INTO request_events (request_id, from_status, to_status, actor, at) VALUES ($1, 'awaiting_approval', 'not_sent', 'platform', '2026-10-28T09:00:00Z')", [expired.request_id]);
    for (const [id, reason] of [[declined.request_id, "declined"], [dismissed, "declined"], [expired.request_id, "expired"]] as const) {
      const { result, requests } = await check({ request_id: id });
      const r = requests[0]!;
      assert.equal(r.status, "not_sent");
      assert.equal(r.reason, reason, id);
      assert.equal(r.held_minor, undefined);
      assert.equal(r.hold_status, "none");
      assert.equal(r.approval_url, undefined, "no link once decided");
      assert.ok(r.transitions.not_sent_at !== undefined);
      assert.match(texts(result).join("\n"), new RegExp(`not sent \\(${reason}\\)`, "i"));
    }
    assert.equal(new Date((await check({ request_id: expired.request_id })).requests[0]!.transitions.not_sent_at!).toISOString(), "2026-10-28T09:00:00.000Z");
  });

  test("A link that can no longer be rebuilt (the stage key rotated) is left out; the expiry stays", async () => {
    const out = await ask();
    await sqlIn(db, "UPDATE requests SET approval_token_hash = $2 WHERE id = $1", [out.request_id, "0".repeat(64)]);
    const r = (await check({ request_id: out.request_id })).requests[0]!;
    assert.equal(r.approval_url, undefined);
    assert.equal(r.approval_expires_at, out.approval_expires_at);
  });

  test("Scenario: Unknown id: not_found and nothing else", async () => {
    const { result } = await check({ request_id: "A2H-ffff" });
    assert.equal(result.isError, true);
    const error = (result.structuredContent as { error: { code: string; detail?: string } }).error;
    assert.equal(error.code, "not_found");
    assert.doesNotMatch(JSON.stringify(result), /sim-|Margaret|principal/);
    const malformed = await check({ request_id: "A2H-FFFF" });
    assert.equal((malformed.result.structuredContent as { error: { code: string } }).error.code, "schema_invalid");
  });

  test("Scenario: Expiry by the platform (display): an expired request reports its hold as released", async () => {
    const id = await send();
    await transition(id, "sent", "expired", "platform", "2026-10-29T09:00:00Z");
    const r = (await check({ request_id: id })).requests[0]!;
    assert.equal(r.status, "expired");
    assert.equal(r.hold_status, "released");
    assert.equal(new Date(r.transitions.expired_at!).toISOString(), "2026-10-29T09:00:00.000Z");
    assert.equal(r.participant_label, undefined, "never accepted: still no name");
  });

  test("Scenario: Old key still verifies: an answer signed before a rotation is shown", async () => {
    const old = await newKey("a2h-test-0000000000000002");
    await sqlIn(db, "INSERT INTO signing_keys (key_id, public_key, status, rotated_at) VALUES ($1, $2, 'rotated', now())", [old.key_id, old.public_key]);
    const id = await send();
    const envelope = await answer(id, "2026-10-27T11:10:00+02:00", old);
    const r = (await check({ request_id: id })).requests[0]!;
    assert.deepEqual(r.answer, envelope);
  });

  test("Scenario: Stored answer that no longer verifies: not shown, answer_unverified by id, left out of lists", async () => {
    // Signed with a key that was active, then revoked after the answer was stored.
    const later = await newKey("a2h-test-0000000000000003");
    // A second active key needs another owner (one active key per owner): the participant's own key.
    await sqlIn(db, "INSERT INTO signing_keys (key_id, public_key, status, participant_id) VALUES ($1, $2, 'active', 'p_sim_mv_7f3c')", [later.key_id, later.public_key]);
    const id = await send();
    await answer(id, "2026-10-27T11:10:00+02:00", later);
    assert.equal((await check({ request_id: id })).requests[0]?.status, "answered", "verifies while the key is active");
    await sqlIn(db, "UPDATE signing_keys SET status = 'revoked', revoked_at = now() WHERE key_id = $1", [later.key_id]);
    const { result } = await check({ request_id: id });
    assert.equal(result.isError, true);
    const error = (result.structuredContent as { error: { code: string; request_id?: string } }).error;
    assert.equal(error.code, "answer_unverified");
    assert.equal(error.request_id, id);
    assert.ok(!JSON.stringify(result).includes(ANSWER_TEXT), "the envelope is not shown");
    const listed = await check({ status: "answered" });
    assert.ok(!listed.requests.some((r) => r.request_id === id), "and it is left out of lists");
    assert.match(texts(listed.result).join("\n"), /left out/);
  });

  test("A stored answer whose body differs from what was signed is not shown either", async () => {
    const id = await send();
    await transition(id, "sent", "accepted", "participant", "2026-10-27T09:05:00Z");
    const signed: UnsignedAnswer = { request_id: id, participant_id: "p_sim_mv_7f3c", body: { verdict: "yes" }, confidence: 4, answered_personally: true, signed_at: "2026-10-27T11:10:00+02:00" };
    const signature = await key.sign(signed);
    await sqlIn(db, `INSERT INTO answers (request_id, participant_id, body, confidence, answered_personally, signed_at, key_id, signature)
      VALUES ($1, 'p_sim_mv_7f3c', $2, 4, true, $3, $4, $5)`, [id, JSON.stringify({ verdict: "no" }), signed.signed_at, key.key_id, signature]);
    await sqlIn(db, "UPDATE requests SET status = 'answered', cleared_minor = 3163 WHERE id = $1", [id]);
    await sqlIn(db, "INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ($1, 'accepted', 'answered', 'participant')", [id]);
    const { result } = await check({ request_id: id });
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, "answer_unverified");
  });

  test("Either an id or a filter, not both", async () => {
    const { result } = await check({ request_id: "A2H-0001", status: "sent" });
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, "schema_invalid");
  });
});
