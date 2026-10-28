// Design D4 amendment (tasks 5.3 and 5.5): at start the worker records the
// stage key it signs with as `active` in signing_keys and moves any previous
// platform key of the stage to `rotated`, so answers signed before a rotation
// still verify through their key_id.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../src/db.ts";
import { registerStageKey } from "../src/signing-keys.ts";
import { skipWithoutDocker, startStageDb, testSigningKey, type StageDb } from "./lib/stage-db.ts";
import type pg from "pg";

const skip = skipWithoutDocker();

describe("stage signing key registration", { skip }, () => {
  let stage: StageDb;
  let pool: pg.Pool;
  before(async () => {
    stage = await startStageDb();
    pool = createPool(stage.db);
  });
  after(async () => {
    await pool?.end();
    await stage?.stop();
  });
  // signing_keys refuses DELETE (forward-only): each case uses fresh key ids,
  // and the assertions look at those ids only.

  async function keys(ids: string[]) {
    const { rows } = await stage.admin.query(
      `SELECT key_id, participant_id, public_key, status, rotated_at FROM signing_keys WHERE key_id = ANY($1) ORDER BY key_id`,
      [ids],
    );
    return rows as { key_id: string; participant_id: string | null; public_key: string; status: string; rotated_at: Date | null }[];
  }

  test("a first start records the key as active, owned by the platform (no participant)", async () => {
    const k = testSigningKey("a2h-pr-12-first0000000001");
    await registerStageKey(pool, k);
    assert.deepEqual(
      (await keys([k.key_id])).map(({ key_id, participant_id, public_key, status }) => ({ key_id, participant_id, public_key, status })),
      [{ key_id: k.key_id, participant_id: null, public_key: k.public_key, status: "active" }],
    );
  });

  test("a restart with the same key changes nothing", async () => {
    const k = testSigningKey("a2h-pr-12-restart00000001");
    await registerStageKey(pool, k);
    const before = await keys([k.key_id]);
    await registerStageKey(pool, k);
    assert.deepEqual(await keys([k.key_id]), before);
  });

  test("a new key after a rotation: the previous platform key becomes rotated, the new one active", async () => {
    const old = testSigningKey("a2h-pr-12-rotate00000001");
    const neu = testSigningKey("a2h-pr-12-rotate00000002");
    await registerStageKey(pool, old);
    await registerStageKey(pool, neu);
    const rows = await keys([old.key_id, neu.key_id]);
    assert.equal(rows[0]!.status, "rotated");
    assert.ok(rows[0]!.rotated_at instanceof Date);
    assert.equal(rows[0]!.public_key, old.public_key, "the rotated key keeps its public key: old answers still verify");
    assert.equal(rows[1]!.status, "active");
    const active = await stage.admin.query(`SELECT key_id FROM signing_keys WHERE participant_id IS NULL AND status = 'active'`);
    assert.deepEqual(active.rows, [{ key_id: neu.key_id }], "exactly one active platform key");
  });

  test("a participant's own key is never rotated by the platform key", async () => {
    const own = testSigningKey("participant-key-0001");
    await stage.admin.query(`INSERT INTO signing_keys (key_id, participant_id, public_key, status) VALUES ($1, 'p_sim_mv_7f3c', $2, 'active')`, [own.key_id, own.public_key]);
    await registerStageKey(pool, testSigningKey("a2h-pr-12-owner000000001"));
    assert.equal((await keys([own.key_id]))[0]!.status, "active");
  });

  test("a key already rotated or revoked is refused: the worker never signs with it", async () => {
    const old = testSigningKey("a2h-pr-12-stale00000001");
    await registerStageKey(pool, old);
    await registerStageKey(pool, testSigningKey("a2h-pr-12-stale00000002"));
    await assert.rejects(registerStageKey(pool, old), /rotated/);
    assert.equal((await keys([old.key_id]))[0]!.status, "rotated");
  });

  test("a public key that is not the private key's own is refused before anything is written", async () => {
    const a = testSigningKey("a2h-pr-12-mismatch000001");
    const b = testSigningKey("unused");
    await assert.rejects(registerStageKey(pool, { ...a, public_key: b.public_key }), /pair/);
    assert.deepEqual(await keys([a.key_id]), []);
  });
});
