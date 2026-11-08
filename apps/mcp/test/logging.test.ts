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
import { TEST_APPROVAL_KEY, TEST_PRINCIPAL, approveOnPage, callRaw, isInputRequired, modernClient, retry, startA2h, texts, urlClient, type RunningA2h } from "./lib/a2h.ts";
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

  test("approval paths: awaiting (link in text), input_required, accept, decline, no state and forged state log ids and codes only, never the link or its token", async () => {
    const plain = await modernClient(server.url);
    const client = await urlClient(server.url);
    try {
      server.logs.length = 0;
      const awaiting = await plain.callTool({ name: "request_human", arguments: BASE });
      const link = RequestHumanOutputSchema.parse(awaiting.structuredContent).approval_url!;
      const first = await callRaw(client, "request_human", BASE);
      assert.ok(isInputRequired(first));
      await retry(client, "request_human", BASE, first.requestState, { approval: { action: "accept" } });
      await retry(client, "request_human", BASE, undefined, { approval: { action: "decline" } }); // conflict: no state
      await assert.rejects(retry(client, "request_human", BASE, "v1.e30.AAAA", { approval: { action: "decline" } }), ProtocolError); // refused by the SDK hook
      const declined = await retry(client, "request_human", BASE, first.requestState, { approval: { action: "decline" } });
      const id = RequestHumanOutputSchema.parse(declined.structuredContent).request_id;
      const lines = toolLines();
      assertClean(server.logs);
      const token = new URL(link).searchParams.get("t")!;
      assert.ok(!JSON.stringify(server.logs).includes(token), "the token is never logged");
      assert.ok(!JSON.stringify(server.logs).includes("/approve/"), "nor the link");
      assert.deepEqual(
        lines.map((l) => [l.outcome, l.code ?? null, l.state ?? null]),
        [
          ["ok", null, "awaiting_approval"],
          ["input_required", null, "awaiting_approval"],
          ["ok", null, "awaiting_approval"],
          ["error", "conflict", null],
          ["not_sent", "declined", "not_sent"],
        ],
      );
      const last = lines.at(-1)!;
      assert.equal(last.request_id, id);
      assert.equal(last.participant_id, "p_sim_mv_7f3c");
      assert.equal(last.principal_id, TEST_PRINCIPAL.principal_id);
    } finally {
      await plain.close();
      await client.close();
    }
  });

  test("find_humans and check_requests (with an answered request): no topic text, no name, no answer body", async () => {
    const client = await modernClient(server.url);
    try {
      const asked = await client.callTool({ name: "request_human", arguments: BASE });
      const out = RequestHumanOutputSchema.parse(asked.structuredContent);
      assert.equal((await approveOnPage(db, out.approval_url!)).kind, "sent");
      const id = out.request_id;
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

  // m2-attachments task 3.3; spec platform/attachments "Logs of an upload"
  // (the mcp part: the agent's refused attachments, and check_requests on a
  // request whose files were uploaded, checked and attached on the page). The
  // worker's part is apps/worker/test/files.test.ts, the page's is task 5.3.
  test("files: no log line carries a file name, a file reference or an object key, whether the agent sends attachments or checks a request with files", async () => {
    const NAMES = ["Compte-rendu Mme Durand.pdf", "radio-thorax-durand.png"];
    const IDS = ["fLOGAAAAAAAAAAAAAAAAAAA", "fLOGBBBBBBBBBBBBBBBBBBB"];
    const client = await modernClient(server.url);
    try {
      server.logs.length = 0;
      // The agent tries to attach files itself, with name-like references.
      await callRaw(client, "request_human", { ...BASE, attachments: [{ ref: NAMES[0], media_type: "application/pdf", size_bytes: 1000 }] });
      // The principal attaches two files on the page, they are checked, and the request is sent.
      const asked = await client.callTool({ name: "request_human", arguments: BASE });
      const out = RequestHumanOutputSchema.parse(asked.structuredContent);
      for (const [i, type] of (["application/pdf", "image/png"] as const).entries()) {
        await sqlIn(
          db,
          `INSERT INTO request_files (id, request_id, principal_id, name, declared_type, media_type, size_bytes, state, object_key, ready_at)
           VALUES ($1, $2, $3, $4, $5, $5, 2048, 'ready', $6, now())`,
          [IDS[i], out.request_id, TEST_PRINCIPAL.principal_id, NAMES[i], type, `uploads/test/files/${out.request_id}/${IDS[i]}`],
        );
      }
      assert.equal((await approveOnPage(db, out.approval_url!)).kind, "sent");
      const checked = await client.callTool({ name: "check_requests", arguments: { request_id: out.request_id } });
      assert.ok(texts(checked).join("\n").includes("Files: 2"), "the agent is told files exist");
      await client.callTool({ name: "check_requests", arguments: { status: "sent" } });
      assert.ok(server.logs.length >= 4);
      assertClean(server.logs);
      const raw = JSON.stringify(server.logs);
      for (const text of [...NAMES, "Durand", ...IDS, "uploads/", "files/"]) assert.ok(!raw.includes(text), `a log line carries "${text}"`);
      const refused = toolLines()[0]!;
      assert.deepEqual([refused.tool, refused.outcome, refused.code], ["request_human", "error", "schema_invalid"]);
    } finally {
      await client.close();
    }
  });
});
