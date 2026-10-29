// Task 4.6 (design D9): every tool call logs one structured line with
// request_id, principal_id, participant_id, state and code, and never the
// question, an answer body, a name or a secret. Captures every log line of
// the blocked, rejected, declined, accepted and answered paths.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ProtocolError } from "@modelcontextprotocol/client";
import { RequestHumanOutputSchema, importPrivateKey, signAnswer } from "@a2h/protocol";
import type { webcrypto } from "node:crypto";
import type { DbConfig } from "../src/config.ts";
import type { LogLine } from "../src/logging.ts";
import { freshSchema, skipWithoutDocker, sqlIn, startPostgres, type PgContainer } from "./lib/db.ts";
import { TEST_APPROVAL_KEY, TEST_PRINCIPAL, callRaw, isInputRequired, modernClient, retry, startA2h, texts, type RunningA2h } from "./lib/a2h.ts";
import { BASE, EDITED, LABOUR, ORIGINAL, PUSH_POLL, THIRD_PARTY } from "./lib/fixtures.ts";

const ANSWER_TEXT = "Plainly worded, but the hypoglycaemia box reads as frightening.";
const SECRETS = [Buffer.from(TEST_APPROVAL_KEY).toString("base64")];
const FORBIDDEN_TEXT = [ORIGINAL, EDITED, PUSH_POLL, THIRD_PARTY, LABOUR, ANSWER_TEXT, "Margaret", "Vale", "diabetes", "insulin", "hypoglycaemia", ...SECRETS];

describe("structured logging (D9)", { skip: skipWithoutDocker() }, () => {
  let pgc: PgContainer;
  let db: DbConfig;
  let server: RunningA2h;

  before(async () => {
    pgc = await startPostgres();
    db = await freshSchema(pgc);
    server = await startA2h(db);
  });
  after(async () => {
    await server?.stop();
    pgc?.stop();
  });

  function toolLines(): LogLine[] {
    return server.logs.filter((l) => l.msg === "tool call");
  }

  function assertClean(lines: LogLine[]): void {
    for (const line of lines) {
      const raw = JSON.stringify(line);
      for (const text of FORBIDDEN_TEXT) assert.ok(!raw.includes(text), `a log line carries "${text.slice(0, 24)}…": ${raw}`);
      for (const value of Object.values(line)) assert.ok(value === undefined || ["string", "number", "boolean"].includes(typeof value), "scalars only");
      // index.ts appends the deployment `stage` to every line: a tool line must not use that key.
      if (line.msg === "tool call") assert.ok(!("stage" in line), `a tool line uses the reserved key stage: ${raw}`);
    }
  }

  test("blocked and rejected paths: one line each with tool, outcome, code, principal_id, participant_id; no text", async () => {
    const client = await modernClient(server.url);
    try {
      server.logs.length = 0;
      await callRaw(client, "request_human", { ...BASE, bid_minor: 100 }); // rules: bid below reserve
      for (const question of [PUSH_POLL, THIRD_PARTY, LABOUR]) await callRaw(client, "request_human", { ...BASE, question }); // content
      await callRaw(client, "request_human", { ...BASE, bid_minor: 30.5 }); // schema
      await callRaw(client, "request_human", { ...BASE, to: "sim-zz-0000" }); // unknown handle
      const lines = toolLines();
      assert.equal(lines.length, 6);
      assertClean(server.logs);
      const [blocked, ...rest] = lines;
      assert.deepEqual(
        { tool: blocked!.tool, outcome: blocked!.outcome, code: blocked!.code, error_stage: blocked!.error_stage, principal_id: blocked!.principal_id, participant_id: blocked!.participant_id },
        { tool: "request_human", outcome: "error", code: "outside_participant_rules", error_stage: "rules", principal_id: TEST_PRINCIPAL.principal_id, participant_id: "p_sim_mv_7f3c" },
      );
      assert.deepEqual(rest.map((l) => l.code), ["forbidden_content", "forbidden_content", "forbidden_content", "schema_invalid", "not_found"]);
      for (const l of lines) {
        assert.equal(typeof l.http_request_id, "string", "correlates with the access line");
        assert.equal(typeof l.duration_ms, "number");
        assert.ok(server.logs.some((a) => a.msg === "request" && a.http_request_id === l.http_request_id), "the access line has the same id");
      }
    } finally {
      await client.close();
    }
  });

  test("approval paths: input_required, conflict, forged state, decline and accept log ids and codes only", async () => {
    const client = await modernClient(server.url);
    try {
      server.logs.length = 0;
      const first = await callRaw(client, "request_human", BASE);
      assert.ok(isInputRequired(first));
      const accept = { approval: { action: "accept", content: { question: EDITED } } };
      await retry(client, "request_human", { ...BASE, bid_minor: 3300 }, first.requestState, accept); // conflict
      await assert.rejects(retry(client, "request_human", BASE, "v1.e30.AAAA", accept), ProtocolError); // refused by the SDK hook
      await retry(client, "request_human", { ...BASE, question: EDITED }, undefined, { approval: { action: "decline" } }); // conflict: no state
      const declineRound = await callRaw(client, "request_human", BASE);
      assert.ok(isInputRequired(declineRound));
      await retry(client, "request_human", BASE, declineRound.requestState, { approval: { action: "decline" } });
      await retry(client, "request_human", BASE, first.requestState, { approval: { action: "accept", content: { question: PUSH_POLL } } }); // edit into a push-poll
      const sent = await retry(client, "request_human", BASE, first.requestState, accept);
      const id = RequestHumanOutputSchema.parse(sent.structuredContent).request_id!;
      const lines = toolLines();
      assertClean(server.logs);
      assert.deepEqual(
        lines.map((l) => [l.outcome, l.code ?? null]),
        [
          ["input_required", null],
          ["error", "conflict"],
          ["error", "conflict"],
          ["input_required", null],
          ["not_sent", "declined"],
          ["error", "forbidden_content"],
          ["ok", null],
        ],
      );
      const ok = lines.at(-1)!;
      assert.equal(ok.request_id, id);
      assert.equal(ok.state, "sent");
      assert.equal(ok.participant_id, "p_sim_mv_7f3c");
      assert.equal(ok.principal_id, TEST_PRINCIPAL.principal_id);
    } finally {
      await client.close();
    }
  });

  test("find_humans and check_requests (with an answered request): no topic text, no name, no answer body", async () => {
    const client = await modernClient(server.url, () => ({ action: "accept", content: { question: ORIGINAL } }));
    try {
      const sent = (await client.callTool({ name: "request_human", arguments: BASE }));
      const id = RequestHumanOutputSchema.parse(sent.structuredContent).request_id!;
      // What the worker writes when the participant answers.
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
      const raw = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64");
      const priv = await importPrivateKey(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
      await sqlIn(db, "INSERT INTO signing_keys (key_id, public_key, status) VALUES ('log-key', $1, 'active')", [raw]);
      const unsigned = { request_id: id, participant_id: "p_sim_mv_7f3c", body: { verdict: "yes" as const, note: { text: ANSWER_TEXT } }, confidence: 3, answered_personally: true as const, signed_at: "2026-10-27T10:00:00+01:00" };
      const signature = await signAnswer(unsigned, priv);
      await sqlIn(db, "UPDATE requests SET status = 'accepted' WHERE id = $1", [id]);
      await sqlIn(db, "INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ($1, 'sent', 'accepted', 'participant')", [id]);
      await sqlIn(db, "INSERT INTO answers (request_id, participant_id, body, confidence, answered_personally, signed_at, key_id, signature) VALUES ($1, $2, $3, 3, true, $4, 'log-key', $5)", [id, unsigned.participant_id, JSON.stringify(unsigned.body), unsigned.signed_at, signature]);
      await sqlIn(db, "UPDATE requests SET status = 'answered', cleared_minor = 3163 WHERE id = $1", [id]);
      await sqlIn(db, "INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ($1, 'accepted', 'answered', 'participant')", [id]);

      server.logs.length = 0;
      const found = (await client.callTool({ name: "find_humans", arguments: { topic: "diabetes patient leaflets", request_type: "judgment" } }));
      assert.ok(!found.isError);
      const checked = (await client.callTool({ name: "check_requests", arguments: { request_id: id } }));
      assert.ok(texts(checked).join("\n").includes(ANSWER_TEXT), "the principal sees the answer");
      await client.callTool({ name: "check_requests", arguments: { status: "answered" } });
      assertClean(server.logs);
      const [find, one, list] = toolLines();
      assert.equal(find!.tool, "find_humans");
      assert.equal(typeof find!.results, "number");
      assert.deepEqual([one!.tool, one!.request_id, one!.state, one!.participant_id], ["check_requests", id, "answered", "p_sim_mv_7f3c"]);
      assert.equal(list!.results, 1);
    } finally {
      await client.close();
    }
  });
});
