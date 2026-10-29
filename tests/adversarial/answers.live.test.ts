// Adversarial suite, answer side, against a live stage (A2H_MCP_URL):
// cases 10 (unsigned answer) and 11 (answer without attestation) of the
// protocol skill §12, as far as they can be observed from outside.
//
// In M1 no endpoint accepts an answer from outside: answers come only from
// the worker's intake (simulated participants), so an unsigned or unattested
// envelope cannot be submitted to a deployed stage. What the stage must
// guarantee, and what this file checks, is the other end: no answer that
// check_requests presents to the principal lacks a signature, a signed time,
// a confidence, a key id or `answered_personally: true`. The submission side
// is attacked in-process in answers.local.test.ts (worker intake, Postgres
// in Docker), which runs in CI with `pnpm test`.
// Run: A2H_MCP_URL=http://<alb>/pr-<n>/mcp pnpm --filter @a2h/tests adversarial
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { answerEnvelopeSchemaFor } from "@a2h/protocol";
import { listSince, principalClient, type A2hClient } from "../contract/a2h.ts";

describe("adversarial: every answer shown to the principal is signed and attested (live)", () => {
  let c: A2hClient;
  before(async () => {
    c = await principalClient();
  });
  after(async () => {
    await c?.close();
  });

  test("cases 10 and 11: no answered request carries an unsigned or unattested envelope", async (t) => {
    const answered = await listSince(c, new Date(Date.UTC(2026, 0, 1)), "answered");
    t.diagnostic(`${answered.length} answered request(s) visible on the stage`);
    // Never pass vacuously: with nothing answered there is nothing to check.
    if (answered.length === 0) {
      t.skip("no answered request on this stage yet: send one to a prompt persona and wait for its answer, then rerun");
      return;
    }
    assert.ok(answered.length >= 1);
    for (const r of answered) {
      const a = r.answer;
      assert.ok(a, `${r.request_id}: answered without an envelope`);
      // Case 10: a signature, its key and its time, in the display form too.
      assert.equal(typeof a.signature, "string", `${r.request_id}: unsigned`);
      assert.equal(Buffer.from(a.signature, "base64").length, 64, `${r.request_id}: not an Ed25519 signature`);
      assert.match(a.key_id, /\S/, `${r.request_id}: no key id`);
      assert.ok(!Number.isNaN(Date.parse(a.signed_at)), `${r.request_id}: no signed time`);
      assert.equal(r.answer_display?.signature, `a2h:sig:…${a.signature.slice(-4)}`);
      // Case 11: the personal attestation, literally true, and a confidence.
      assert.equal(a.answered_personally, true, `${r.request_id}: not attested`);
      assert.ok(Number.isInteger(a.confidence) && a.confidence >= 1 && a.confidence <= 5, `${r.request_id}: confidence ${a.confidence}`);
      // The whole envelope, strictly, for the request's intent.
      answerEnvelopeSchemaFor(r.intent).parse(a);
      assert.equal(a.request_id, r.request_id);
    }
  });
});
