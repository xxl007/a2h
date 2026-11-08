// m2-attachments tasks 2.3 and 2.4 against PostgreSQL 17: migration 0012
// (`request_files`, the rules' attachment setting), the file queries the
// approval page and the worker call (design D1, D2, D5, D6), and Send with
// files (D4). Scenario names are those of the change's spec deltas
// (platform/attachments, platform/approval-page, protocol/request-approval,
// protocol/schemas).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { approvalTokenHash, formatApprovalToken, formatFileId, type Manifest } from "@a2h/protocol";
import {
  addRequestFile,
  createAwaitingRequest,
  currentRules,
  decideApproval,
  deleteUnsentRequestFiles,
  ensurePrincipal,
  fileForReading,
  findPublishedParticipant,
  listRequestFiles,
  manifestOfRequest,
  markFileChecking,
  markFileReady,
  refuseFile,
  removeRequestFile,
  type A2hDb,
  type RequestRow,
} from "../src/index.ts";
import { SEED_SQL_PATH } from "../seed/sql.ts";
import { migrate, skipWithoutDocker, startPostgres, statementsOf, type PgContainer } from "./lib/postgres.ts";

const skip = skipWithoutDocker();
const MB = 1024 * 1024;
const NOW = new Date("2026-10-27T09:00:00Z");
const LATER = new Date(NOW.getTime() + 3_600_000);
const PRINCIPAL = "user-files-principal";
const OTHER = "user-files-other";
const FEE_RATE = 0.2;
const POLICY = { currency: "EUR", monthly_budget_minor: 500_000, per_request_cap_minor: 6_000, ask_first_above_minor: null, daily_request_limit: 500, throttled_daily_limit: 5 };
const QUESTION = "Would a patient with type 2 diabetes find the attached leaflet's section on insulin alarming?";

/** The default persona (rules without a stated setting: files up to 50 MB). */
const MV = { to: "sim-mv-7f3c", intent: "judgment", bid_minor: 3200 } as const;
/** The persona whose rules refuse files (seed, task 2.5). */
const TH = { to: "sim-th-2a91", intent: "knowledge", bid_minor: 5700 } as const;
/** The persona whose rules accept files up to 5 MB (seed, task 2.5). */
const OL = { to: "sim-ol-6a23", intent: "judgment", bid_minor: 3800 } as const;

let pgc: PgContainer;
let schemas = 0;
const pools: pg.Pool[] = [];

interface Fresh {
  db: A2hDb;
  pool: pg.Pool;
  sql: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;
}

async function fresh(): Promise<Fresh> {
  const schema = `f${process.pid}_${++schemas}`;
  const client = new pg.Client({ connectionString: pgc.url });
  await client.connect();
  try {
    await migrate(client, schema);
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path = ${schema}`);
    await client.query(`SELECT set_config('a2h.stage', 'test', true)`);
    for (const statement of statementsOf(SEED_SQL_PATH)) await client.query(statement);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
  const pool = new pg.Pool({ connectionString: pgc.url, max: 4, options: `-c search_path=${schema}` });
  pools.push(pool);
  const db = drizzle(pool) as unknown as A2hDb;
  for (const id of [PRINCIPAL, OTHER]) await ensurePrincipal(db, id, { policy: POLICY });
  const sql = async <T,>(text: string, values: unknown[] = []) => (await pool.query(text, values)).rows as T[];
  return { db, pool, sql };
}

interface Awaiting {
  id: string;
  token: string;
}

let ids = 0;
async function awaiting(f: Fresh, who: { to: string; intent: Manifest["intent"]; bid_minor: number } = MV, expiresAt?: Date): Promise<Awaiting> {
  const id = `A2H-${(0xf000 + ++ids).toString(16)}`;
  const token = formatApprovalToken(Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + ids) & 255));
  const m: Manifest = {
    to: who.to,
    intent: who.intent,
    audience: "named_individual",
    time_shape: "one_shot",
    format: "single_field",
    question: QUESTION,
    lane: "paid",
    bid_minor: who.bid_minor,
    currency: "EUR",
    expires_at: "2026-10-29T09:00:00+00:00",
    data_terms: { storage: "principal_workspace", attribution: "attributed", training: "off" },
    principal_id: PRINCIPAL,
  };
  const participant = (await findPublishedParticipant(f.db, m.to))!;
  await createAwaitingRequest(f.db, {
    id,
    manifest: m,
    participant_id: participant.participant_id,
    deliver_at: NOW,
    approval_token_hash: await approvalTokenHash(token),
    approval_expires_at: expiresAt ?? new Date(NOW.getTime() + 24 * 3_600_000),
    now: NOW,
  });
  return { id, token };
}

let fileSeq = 0;
function newFile(a: Awaiting, over: { size_bytes?: number; declared_type?: string; name?: string } = {}) {
  const n = ++fileSeq;
  const id = formatFileId(Uint8Array.from({ length: 16 }, (_, i) => (i === 0 ? n & 255 : i === 1 ? n >> 8 : i * 7) & 255));
  return {
    id,
    name: over.name ?? `leaflet-${fileSeq}.pdf`,
    declared_type: over.declared_type ?? "application/pdf",
    size_bytes: over.size_bytes ?? 2 * MB,
    object_key: `tmp/pr-0/files/${a.id}/${id}`,
  };
}

const access = (a: Awaiting, over: { principal_id?: string; token?: string; now?: Date } = {}) => ({
  request_id: a.id,
  token: over.token ?? a.token,
  principal_id: over.principal_id ?? PRINCIPAL,
  now: over.now ?? LATER,
});

async function add(f: Fresh, a: Awaiting, over: Parameters<typeof newFile>[1] = {}) {
  const file = newFile(a, over);
  const r = await addRequestFile(f.db, { ...access(a), file });
  assert.equal(r.kind, "added", JSON.stringify(r));
  return file;
}

/** A file through the worker's checks to `ready` (D3), moved to the uploads area. */
async function addReady(f: Fresh, a: Awaiting, over: Parameters<typeof newFile>[1] = {}, mediaType = "application/pdf") {
  const file = await add(f, a, over);
  assert.equal(await markFileChecking(f.db, file.id, mediaType), true);
  assert.equal(await markFileReady(f.db, file.id, file.object_key.replace(/^tmp\//, "uploads/"), LATER), true);
  return file;
}

const send = (a: Awaiting, over: { principal_id?: string } = {}) => ({
  request_id: a.id,
  token: a.token,
  principal_id: over.principal_id ?? PRINCIPAL,
  now: LATER,
  fee_rate: FEE_RATE,
  decision: { kind: "send" as const, question: QUESTION },
});
const dontSend = (a: Awaiting) => ({ ...send(a), decision: { kind: "dont_send" as const } });

async function requestRow(f: Fresh, id: string) {
  const [r] = await f.sql<{ status: string; attachments: unknown }>("SELECT status, attachments FROM requests WHERE id = $1", [id]);
  return r!;
}
async function blockedCodes(f: Fresh, id: string): Promise<string[]> {
  return (await f.sql<{ code: string }>("SELECT code FROM blocked_manifests WHERE request_id = $1 ORDER BY id", [id])).map((r) => r.code);
}

describe("request files (m2-attachments 2.3, 2.4, Postgres 17)", { skip }, () => {
  before(async () => {
    pgc = await startPostgres();
  });
  after(async () => {
    for (const p of pools) await p.end().catch(() => undefined);
    pgc?.stop();
  });

  describe("migration 0012", () => {
    test("Scenario: Rules without the setting (data part): a rules row written without the setting reads as files accepted up to 50 MB", async () => {
      const f = await fresh();
      await f.sql("INSERT INTO participants (id, handle, display_label, simulated) VALUES ('p_old', 'old-0001', 'Old', false)");
      await f.sql("INSERT INTO rules (participant_id, who_may_ask, max_interruptions_per_day, latency_promise_seconds) VALUES ('p_old', 'anyone_verified', 3, 3600)");
      const [cols] = await f.sql<{ attachments_accepted: boolean; attachments_max_total_bytes: number }>("SELECT attachments_accepted, attachments_max_total_bytes FROM rules WHERE participant_id = 'p_old'");
      assert.deepEqual(cols, { attachments_accepted: true, attachments_max_total_bytes: 52428800 });
      assert.deepEqual((await currentRules(f.db, "p_old")).attachments, { accepted: true, max_total_bytes: 52428800 });
    });

    test("Scenario: Setting present (data part): the stored setting is what validation reads, on both loaders", async () => {
      const f = await fresh();
      const th = (await findPublishedParticipant(f.db, TH.to))!;
      assert.deepEqual(th.rules.attachments, { accepted: false, max_total_bytes: 0 });
      assert.deepEqual((await currentRules(f.db, th.participant_id)).attachments, { accepted: false, max_total_bytes: 0 });
      const ol = (await findPublishedParticipant(f.db, OL.to))!;
      assert.deepEqual(ol.rules.attachments, { accepted: true, max_total_bytes: 5 * MB });
    });

    test("the rules' setting is bounded: 0..50 MB", async () => {
      const f = await fresh();
      await assert.rejects(f.sql("UPDATE rules SET attachments_max_total_bytes = 52428801"), /rules_attachments_max_total_bytes/);
      await assert.rejects(f.sql("UPDATE rules SET attachments_max_total_bytes = -1"), /rules_attachments_max_total_bytes/);
    });

    test("request_files refuses rows outside the protocol: unknown state or reason, a refusal without its reason, a ready file without its type, sizes out of range, a malformed id", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const base = { id: "fAAAAAAAAAAAAAAAAAAAAAA", state: "uploading", reason: null as string | null, media: null as string | null, size: 1000, ready: null as Date | null };
      const insert = (o: Partial<typeof base>) => {
        const v = { ...base, ...o };
        return f.sql(
          `INSERT INTO request_files (id, request_id, principal_id, name, declared_type, media_type, size_bytes, state, refused_reason, object_key, ready_at)
           VALUES ($1, $2, $3, 'x.pdf', 'application/pdf', $4, $5, $6, $7, 'tmp/k', $8)`,
          [v.id, a.id, PRINCIPAL, v.media, v.size, v.state, v.reason, v.ready],
        );
      };
      await assert.rejects(insert({ state: "scanning" }), /request_files_state_known/);
      await assert.rejects(insert({ state: "refused" }), /request_files_refused_has_reason/);
      await assert.rejects(insert({ reason: "type" }), /request_files_refused_has_reason/);
      await assert.rejects(insert({ state: "refused", reason: "virus" }), /request_files_refused_reason_known/);
      await assert.rejects(insert({ state: "ready", media: "application/pdf" }), /request_files_ready_complete/);
      await assert.rejects(insert({ state: "checking" }), /request_files_checked_type/);
      await assert.rejects(insert({ media: "text/html", state: "checking" }), /request_files_media_type_known/);
      await assert.rejects(insert({ size: 0 }), /request_files_size/);
      await assert.rejects(insert({ size: 25 * MB + 1 }), /request_files_size/);
      await assert.rejects(insert({ id: "-AAAAAAAAAAAAAAAAAAAAAA" }), /request_files_id_format/);
      await insert({});
      assert.equal((await listRequestFiles(f.db, a.id)).length, 1);
    });
  });

  describe("addRequestFile (D2): limits checked under the request's lock, before anything is stored", () => {
    test("Scenario: Allowed file (data part): a 2 MB PDF on a request with no files is recorded uploading, with its size; its type is set by the check", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const file = newFile(a);
      const r = await addRequestFile(f.db, { ...access(a), file });
      assert.equal(r.kind, "added");
      const [listed] = await listRequestFiles(f.db, a.id);
      assert.deepEqual(
        { id: listed!.id, name: listed!.name, state: listed!.state, size: listed!.size_bytes, media: listed!.media_type, declared: listed!.declared_type, reason: listed!.refused_reason },
        { id: file.id, name: file.name, state: "uploading", size: 2 * MB, media: null, declared: "application/pdf", reason: null },
      );
      assert.equal(await markFileChecking(f.db, file.id, "application/pdf"), true);
      assert.equal((await listRequestFiles(f.db, a.id))[0]!.media_type, "application/pdf");
    });

    test("Scenario: Too large: over 25 MB, or over 50 MB with the request's other files, is refused with the limit, and nothing is recorded", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      assert.deepEqual(await addRequestFile(f.db, { ...access(a), file: newFile(a, { size_bytes: 25 * MB + 1 }) }), { kind: "refused", reason: "size", limit: "file" });
      await add(f, a, { size_bytes: 25 * MB });
      await add(f, a, { size_bytes: 24 * MB });
      assert.deepEqual(await addRequestFile(f.db, { ...access(a), file: newFile(a, { size_bytes: MB + 1 }) }), { kind: "refused", reason: "size", limit: "request" });
      await add(f, a, { size_bytes: MB });
      assert.equal((await listRequestFiles(f.db, a.id)).length, 3);
    });

    test("Scenario: Too many: with 5 files held, a sixth is refused with the limit; a refused file does not count", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const files = [];
      for (let i = 0; i < 5; i++) files.push(await add(f, a, { size_bytes: MB }));
      assert.deepEqual(await addRequestFile(f.db, { ...access(a), file: newFile(a, { size_bytes: MB }) }), { kind: "refused", reason: "count" });
      assert.ok(await refuseFile(f.db, files[0]!.id, "type"));
      await add(f, a, { size_bytes: MB });
      assert.equal((await listRequestFiles(f.db, a.id)).length, 6, "the refused file stays listed until removed");
    });

    test("Scenario: Type not allowed (declared): a ZIP or an executable is refused before it is stored", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      for (const declared_type of ["application/zip", "application/x-msdownload", "text/html", ""]) {
        assert.deepEqual(await addRequestFile(f.db, { ...access(a), file: newFile(a, { declared_type }) }), { kind: "refused", reason: "type" }, declared_type);
      }
      assert.deepEqual(await listRequestFiles(f.db, a.id), []);
    });

    test("a name is kept as given, at most 255 characters; a longer one is refused as a type the page cannot list", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      await add(f, a, { name: "Notice «patient» é 中文.pdf" });
      assert.equal((await listRequestFiles(f.db, a.id))[0]!.name, "Notice «patient» é 中文.pdf");
      await assert.rejects(addRequestFile(f.db, { ...access(a), file: newFile(a, { name: "x".repeat(256) }) }), RangeError);
      await assert.rejects(addRequestFile(f.db, { ...access(a), file: newFile(a, { name: "" }) }), RangeError);
    });

    test("Scenario: Another account, Forged token, Old link: nothing is recorded", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      assert.deepEqual(await addRequestFile(f.db, { ...access(a, { principal_id: OTHER }), file: newFile(a) }), { kind: "wrong_principal" });
      assert.deepEqual(await addRequestFile(f.db, { ...access(a, { token: formatApprovalToken(new Uint8Array(32).fill(9)) }), file: newFile(a) }), { kind: "link_invalid" });
      assert.deepEqual(await addRequestFile(f.db, { ...access(a, { token: "not a token" }), file: newFile(a) }), { kind: "link_invalid" });
      const old = await awaiting(f, MV, new Date(NOW.getTime() + 60_000));
      assert.deepEqual(await addRequestFile(f.db, { ...access(old), file: newFile(old) }), { kind: "expired" });
      assert.deepEqual(await listRequestFiles(f.db, a.id), []);
      assert.deepEqual(await listRequestFiles(f.db, old.id), []);
    });
  });

  describe("removeRequestFile and fileForReading (D5, D6)", () => {
    test("Scenario: Remove a file: it disappears from the list and is not part of the request; its object key is returned for deletion", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const kept = await addReady(f, a);
      const gone = await addReady(f, a);
      assert.deepEqual(await removeRequestFile(f.db, { ...access(a), file_id: gone.id }), { kind: "removed", object_key: gone.object_key.replace(/^tmp\//, "uploads/") });
      assert.deepEqual((await listRequestFiles(f.db, a.id)).map((x) => x.id), [kept.id]);
      assert.deepEqual(await removeRequestFile(f.db, { ...access(a), file_id: gone.id }), { kind: "not_found" }, "removed once");
      assert.deepEqual(await removeRequestFile(f.db, { ...access(a, { principal_id: OTHER }), file_id: kept.id }), { kind: "wrong_principal" });
      const sent = await decideApproval(f.db, send(a));
      assert.equal(sent.kind, "sent", JSON.stringify(sent));
      assert.deepEqual((await requestRow(f, a.id)).attachments, [{ ref: kept.id, media_type: "application/pdf", size_bytes: 2 * MB }]);
    });

    test("Scenario: Principal opens their file: a ready file of their request gives its key and recorded type; Scenario: Another account: nothing", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const ready = await addReady(f, a, { declared_type: "image/png" }, "image/png");
      const checking = await add(f, a);
      assert.deepEqual(await fileForReading(f.db, { ...access(a), file_id: ready.id }), { object_key: ready.object_key.replace(/^tmp\//, "uploads/"), media_type: "image/png" });
      for (const [why, q] of [
        ["another account", { ...access(a, { principal_id: OTHER }), file_id: ready.id }],
        ["a forged token", { ...access(a, { token: formatApprovalToken(new Uint8Array(32).fill(4)) }), file_id: ready.id }],
        ["a file not yet ready", { ...access(a), file_id: checking.id }],
        ["an unknown file", { ...access(a), file_id: "fZZZZZZZZZZZZZZZZZZZZZZ" }],
      ] as const) {
        assert.equal(await fileForReading(f.db, q), null, why);
      }
    });

    test("Scenario: Files on a sent request (data part): listed and readable after Send, never addable or removable", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const file = await addReady(f, a);
      assert.equal((await decideApproval(f.db, send(a))).kind, "sent");
      assert.equal((await listRequestFiles(f.db, a.id)).length, 1);
      assert.ok(await fileForReading(f.db, { ...access(a, { now: new Date(NOW.getTime() + 48 * 3_600_000) }), file_id: file.id }), "readable after the link's expiry once sent");
      assert.deepEqual(await addRequestFile(f.db, { ...access(a), file: newFile(a) }), { kind: "not_awaiting" });
      assert.deepEqual(await removeRequestFile(f.db, { ...access(a), file_id: file.id }), { kind: "not_awaiting" });
    });
  });

  describe("the worker's marks (D3): monotonic, and only while the request awaits approval", () => {
    test("uploading → checking → ready; refused from uploading or checking; nothing leaves ready or refused", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const x = await add(f, a);
      assert.equal(await markFileReady(f.db, x.id, "uploads/k", LATER), false, "not ready before checking");
      assert.equal(await markFileChecking(f.db, x.id, "application/pdf"), true);
      assert.equal(await markFileChecking(f.db, x.id, "application/pdf"), false, "once");
      assert.equal(await markFileReady(f.db, x.id, "uploads/k", LATER), true);
      assert.equal(await markFileReady(f.db, x.id, "uploads/k2", LATER), false, "a duplicate scan result changes nothing");
      assert.equal(await refuseFile(f.db, x.id, "malware"), null, "a ready file is not refused by a late event");
      const y = await add(f, a);
      assert.deepEqual(await refuseFile(f.db, y.id, "not_checked"), { object_key: y.object_key });
      assert.equal(await markFileChecking(f.db, y.id, "application/pdf"), false);
      const [ry] = (await listRequestFiles(f.db, a.id)).filter((r) => r.id === y.id);
      assert.deepEqual([ry!.state, ry!.refused_reason], ["refused", "not_checked"]);
      await assert.rejects(markFileChecking(f.db, x.id, "text/html"), RangeError, "only an allowed type is recorded");
    });

    test("Scenario: Don't send (data part): the unsent request's files are marked deleted and their keys returned once; a sent request's files are not touched", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const one = await addReady(f, a);
      const two = await add(f, a);
      assert.deepEqual(await decideApproval(f.db, dontSend(a)), { kind: "not_sent", reason: "declined" });
      assert.equal(await markFileChecking(f.db, two.id, "application/pdf"), false, "no mark once the request is not sent");
      assert.deepEqual((await deleteUnsentRequestFiles(f.db, a.id, LATER)).sort(), [one.object_key.replace(/^tmp\//, "uploads/"), two.object_key].sort());
      assert.deepEqual(await deleteUnsentRequestFiles(f.db, a.id, LATER), [], "once");
      assert.deepEqual(await listRequestFiles(f.db, a.id), []);
      const s = await awaiting(f);
      await addReady(f, s);
      assert.equal((await decideApproval(f.db, send(s))).kind, "sent");
      assert.deepEqual(await deleteUnsentRequestFiles(f.db, s.id, LATER), []);
      assert.equal((await listRequestFiles(f.db, s.id)).length, 1);
    });
  });

  describe("decideApproval with files (D4)", () => {
    test("Scenario: Add and send: a ready PDF becomes the manifest's attachments (ref, type, size) on the request, in one transaction with the transition", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const pdf = await addReady(f, a);
      const png = await addReady(f, a, { declared_type: "image/png", size_bytes: 300 * 1024 }, "image/png");
      const sent = await decideApproval(f.db, send(a));
      assert.equal(sent.kind, "sent", JSON.stringify(sent));
      const r = await requestRow(f, a.id);
      assert.equal(r.status, "sent");
      const expected = [
        { ref: pdf.id, media_type: "application/pdf", size_bytes: 2 * MB },
        { ref: png.id, media_type: "image/png", size_bytes: 300 * 1024 },
      ];
      assert.deepEqual(r.attachments, expected);
      const [full] = await f.sql<RequestRow>("SELECT * FROM requests WHERE id = $1", [a.id]);
      assert.deepEqual(manifestOfRequest(full!, MV.to).attachments, expected, "delivery re-validates the same files");
    });

    test("Scenario: Send waits for checking: a file still uploading or checking refuses Send with files_not_ready; nothing changes; ready, it sends", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const x = await add(f, a);
      for (const step of ["uploading", "checking"]) {
        if (step === "checking") await markFileChecking(f.db, x.id, "application/pdf");
        const r = await decideApproval(f.db, send(a));
        assert.equal(r.kind, "invalid", step);
        if (r.kind === "invalid") assert.deepEqual([r.error.code, r.error.stage, r.error.retryable], ["files_not_ready", "lifecycle", true], step);
        assert.deepEqual(await requestRow(f, a.id), { status: "awaiting_approval", attachments: null }, step);
        assert.deepEqual(await blockedCodes(f, a.id), [], `${step}: not a rules block`);
      }
      await markFileReady(f.db, x.id, "uploads/k", LATER);
      assert.equal((await decideApproval(f.db, send(a))).kind, "sent");
    });

    test("Scenario: Refused file blocks Send until removed (data part)", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      await addReady(f, a);
      const bad = await add(f, a);
      await refuseFile(f.db, bad.id, "malware");
      const r = await decideApproval(f.db, send(a));
      assert.ok(r.kind === "invalid" && r.error.code === "files_not_ready", JSON.stringify(r));
      await removeRequestFile(f.db, { ...access(a), file_id: bad.id });
      assert.equal((await decideApproval(f.db, send(a))).kind, "sent");
      assert.equal((await requestRow(f, a.id)).attachments instanceof Array, true);
    });

    test("Scenario: Participant does not accept files: Send is refused outside_participant_rules, counted, and the request stays awaiting approval with its file", async () => {
      const f = await fresh();
      const a = await awaiting(f, TH);
      const file = await addReady(f, a);
      const r = await decideApproval(f.db, send(a));
      assert.equal(r.kind, "invalid");
      if (r.kind === "invalid") {
        assert.deepEqual([r.error.code, r.error.stage], ["outside_participant_rules", "rules"]);
        assert.doesNotMatch(JSON.stringify(r.error), /attach|file|accept/i);
      }
      assert.deepEqual(await requestRow(f, a.id), { status: "awaiting_approval", attachments: null });
      assert.deepEqual(await blockedCodes(f, a.id), ["attachments_not_accepted"]);
      assert.deepEqual((await listRequestFiles(f.db, a.id)).map((x) => x.id), [file.id]);
    });

    test("Scenario: Files over the participant's total: 6 MB against a 5 MB total is refused the same way", async () => {
      const f = await fresh();
      const a = await awaiting(f, OL);
      await addReady(f, a, { size_bytes: 3 * MB });
      await addReady(f, a, { size_bytes: 3 * MB });
      const r = await decideApproval(f.db, send(a));
      assert.ok(r.kind === "invalid" && r.error.code === "outside_participant_rules", JSON.stringify(r));
      assert.deepEqual(await blockedCodes(f, a.id), ["attachments_over_total"]);
      assert.equal((await requestRow(f, a.id)).status, "awaiting_approval");
    });

    test("Scenario: Removing the files makes it sendable: after the refusal, the principal removes the file and Send validates without files", async () => {
      const f = await fresh();
      const a = await awaiting(f, TH);
      const file = await addReady(f, a);
      assert.equal((await decideApproval(f.db, send(a))).kind, "invalid");
      assert.equal((await removeRequestFile(f.db, { ...access(a), file_id: file.id })).kind, "removed");
      const sent = await decideApproval(f.db, send(a));
      assert.equal(sent.kind, "sent", JSON.stringify(sent));
      assert.deepEqual(await requestRow(f, a.id), { status: "sent", attachments: null });
    });

    test("Scenario: Request without files is unaffected: a participant who refuses files receives a request without any", async () => {
      const f = await fresh();
      const a = await awaiting(f, TH);
      assert.equal((await decideApproval(f.db, send(a))).kind, "sent");
    });

    test("Scenario: Sent files are fixed: after Send no file can be added, removed, replaced or re-marked, by the queries or by direct SQL", async () => {
      const f = await fresh();
      const a = await awaiting(f);
      const file = await addReady(f, a);
      assert.equal((await decideApproval(f.db, send(a))).kind, "sent");
      assert.deepEqual(await addRequestFile(f.db, { ...access(a), file: newFile(a) }), { kind: "not_awaiting" });
      assert.deepEqual(await removeRequestFile(f.db, { ...access(a), file_id: file.id }), { kind: "not_awaiting" });
      assert.equal(await refuseFile(f.db, file.id, "malware"), null);
      // The database refuses it too, whoever asks.
      await assert.rejects(f.sql("UPDATE request_files SET deleted_at = now() WHERE id = $1", [file.id]), /request_files of a sent request are fixed/);
      await assert.rejects(f.sql("UPDATE request_files SET size_bytes = 1, object_key = 'uploads/other' WHERE id = $1", [file.id]), /request_files of a sent request are fixed/);
      await assert.rejects(f.sql("DELETE FROM request_files WHERE id = $1", [file.id]), /request_files of a sent request are fixed/);
      await assert.rejects(
        f.sql(
          `INSERT INTO request_files (id, request_id, principal_id, name, declared_type, size_bytes, state, object_key) VALUES ('fBBBBBBBBBBBBBBBBBBBBBB', $1, $2, 'x.pdf', 'application/pdf', 10, 'uploading', 'tmp/x')`,
          [a.id, PRINCIPAL],
        ),
        /request_files of a sent request are fixed/,
      );
      assert.deepEqual((await requestRow(f, a.id)).attachments, [{ ref: file.id, media_type: "application/pdf", size_bytes: 2 * MB }]);
    });

    test("concurrent remove versus Send: serialised by the request's lock; the sent attachments are exactly the files not removed", async (t) => {
      const f = await fresh();
      const seen = { removed_first: 0, sent_first: 0 };
      for (let round = 0; round < 12; round++) {
        const a = await awaiting(f);
        const kept = await addReady(f, a);
        const raced = await addReady(f, a);
        const [sent, removed] = await Promise.all([
          decideApproval(f.db, send(a)),
          removeRequestFile(f.db, { ...access(a), file_id: raced.id }),
        ]);
        assert.equal(sent.kind, "sent", JSON.stringify(sent));
        const r = await requestRow(f, a.id);
        const refs = (r.attachments as { ref: string }[]).map((x) => x.ref);
        if (removed.kind === "removed") {
          assert.deepEqual(refs, [kept.id], `round ${round}: removed before Send`);
          seen.removed_first++;
        } else {
          assert.deepEqual(removed, { kind: "not_awaiting" }, `round ${round}`);
          assert.deepEqual(refs, [kept.id, raced.id], `round ${round}: Send first, the file stays`);
          seen.sent_first++;
        }
        assert.deepEqual((await listRequestFiles(f.db, a.id)).map((x) => x.id), refs, `round ${round}: the list and the manifest agree`);
      }
      t.diagnostic(`orders seen: ${JSON.stringify(seen)}`);
    });

    test("concurrent add versus Send: a file added while Send runs is either part of the request or refused, never left behind unsent", async () => {
      const f = await fresh();
      for (let round = 0; round < 8; round++) {
        const a = await awaiting(f);
        await addReady(f, a);
        const [sent, added] = await Promise.all([decideApproval(f.db, send(a)), addRequestFile(f.db, { ...access(a), file: newFile(a) })]);
        if (added.kind === "added") {
          // Added first, still uploading: Send must have waited for it.
          assert.ok(sent.kind === "invalid" && sent.error.code === "files_not_ready", `round ${round}: ${JSON.stringify(sent)}`);
        } else {
          assert.deepEqual(added, { kind: "not_awaiting" }, `round ${round}`);
          assert.equal(sent.kind, "sent", `round ${round}`);
        }
      }
    });
  });
});
