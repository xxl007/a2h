// m2-approval-page design D2: the approval link's token and expiry, pure.
// The token is 32 random bytes in base64url (the caller draws the bytes);
// only its SHA-256 is stored. The link lives 24 hours, or until the
// request's own expiry minus the participant's latency promise when that is
// sooner, and at least 15 minutes; otherwise there is no link.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  APPROVAL_LINK_MAX_SECONDS,
  APPROVAL_LINK_MIN_SECONDS,
  ApprovalTokenSchema,
  approvalLinkExpiry,
  approvalTokenHash,
  approvalUrl,
  deriveApprovalToken,
  formatApprovalToken,
} from "../src/index.ts";

const NOW = "2026-11-03T10:00:00.000Z";
const hours = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();

describe("approval token (D2)", () => {
  test("32 bytes become 43 base64url characters, no padding", () => {
    const token = formatApprovalToken(new Uint8Array(32).fill(255));
    assert.equal(token, "_".repeat(42) + "8");
    assert.ok(ApprovalTokenSchema.safeParse(token).success);
    assert.ok(ApprovalTokenSchema.safeParse(formatApprovalToken(Uint8Array.from({ length: 32 }, (_, i) => i * 7))).success);
  });
  test("anything but exactly 32 bytes is refused", () => {
    assert.throws(() => formatApprovalToken(new Uint8Array(16)), TypeError);
    assert.throws(() => formatApprovalToken(new Uint8Array(33)), TypeError);
  });
  test("the schema refuses other lengths and alphabets", () => {
    for (const bad of ["", "a".repeat(42), "a".repeat(44), "+".repeat(43), "=".repeat(43)]) assert.equal(ApprovalTokenSchema.safeParse(bad).success, false, bad);
  });
  test("the stored form is the lower-case hex SHA-256 of the token", async () => {
    // SHA-256("abc"), FIPS 180-2 test vector.
    assert.equal(await approvalTokenHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const a = await approvalTokenHash(formatApprovalToken(new Uint8Array(32)));
    assert.match(a, /^[0-9a-f]{64}$/);
  });
  test("the link is https://<web host>/approve/<request id>?t=<token>", () => {
    const token = formatApprovalToken(new Uint8Array(32));
    assert.equal(approvalUrl("https://pr-72.dev.a2h-protocol.org", "A2H-7f3c", token), `https://pr-72.dev.a2h-protocol.org/approve/A2H-7f3c?t=${token}`);
    assert.equal(approvalUrl("https://dev.a2h-protocol.org/", "A2H-7f3c", token), `https://dev.a2h-protocol.org/approve/A2H-7f3c?t=${token}`);
  });
  test("a web host that is not https, or a malformed id or token, is a caller error", () => {
    const token = formatApprovalToken(new Uint8Array(32));
    assert.throws(() => approvalUrl("http://dev.a2h-protocol.org", "A2H-7f3c", token), TypeError);
    assert.throws(() => approvalUrl("https://dev.a2h-protocol.org", "A2H-7F3C", token), TypeError);
    assert.throws(() => approvalUrl("https://dev.a2h-protocol.org", "A2H-7f3c", "short"), TypeError);
  });
});

describe("derived token (group 3): HMAC-SHA256(stage key, request id), so check_requests can show the link again", () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i);
  test("a valid token, the same for the same key and id, different for another id or key", async () => {
    const a = await deriveApprovalToken(key, "A2H-7f3c");
    assert.ok(ApprovalTokenSchema.safeParse(a).success, a);
    assert.equal(await deriveApprovalToken(key, "A2H-7f3c"), a);
    assert.notEqual(await deriveApprovalToken(key, "A2H-7f3d"), a);
    assert.notEqual(await deriveApprovalToken(Uint8Array.from({ length: 32 }, (_, i) => i + 1), "A2H-7f3c"), a);
  });
  test("equals base64url(HMAC-SHA256(key, \"a2h-approval-link:\" + id)), computed independently with node:crypto", async () => {
    const expected = createHmac("sha256", key).update("a2h-approval-link:A2H-7f3c").digest("base64url");
    assert.equal(await deriveApprovalToken(key, "A2H-7f3c"), expected);
  });
  test("a short key or a malformed id is a caller error", async () => {
    await assert.rejects(deriveApprovalToken(new Uint8Array(16), "A2H-7f3c"), TypeError);
    await assert.rejects(deriveApprovalToken(key, "A2H-7F3C"), TypeError);
  });
});

describe("approval link expiry (D2, proposal decision 3)", () => {
  test("24 hours when the request's expiry minus the latency promise is later", () => {
    assert.equal(APPROVAL_LINK_MAX_SECONDS, 86_400);
    assert.equal(approvalLinkExpiry({ now: NOW, expires_at: hours(72), latency_promise_seconds: 6 * 3600 }), hours(24));
  });
  test("the request's expiry minus the latency promise when that is sooner", () => {
    assert.equal(approvalLinkExpiry({ now: NOW, expires_at: hours(10), latency_promise_seconds: 6 * 3600 }), hours(4));
  });
  test("exactly 15 minutes is enough; less gives no link", () => {
    assert.equal(APPROVAL_LINK_MIN_SECONDS, 900);
    assert.equal(approvalLinkExpiry({ now: NOW, expires_at: hours(1 + 0.25), latency_promise_seconds: 3600 }), hours(0.25));
    assert.equal(approvalLinkExpiry({ now: NOW, expires_at: hours(1.2), latency_promise_seconds: 3600 }), null);
    assert.equal(approvalLinkExpiry({ now: NOW, expires_at: hours(-1), latency_promise_seconds: 0 }), null);
  });
  test("accepts offsets and returns UTC", () => {
    assert.equal(approvalLinkExpiry({ now: "2026-11-03T11:00:00+01:00", expires_at: "2026-11-10T00:00:00+01:00", latency_promise_seconds: 0 }), hours(24));
  });
});
