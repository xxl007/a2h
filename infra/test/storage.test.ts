// Lifecycle rules of the uploads bucket must cover every stage's keys
// (`<area>/<STORAGE_PREFIX><key>`), now that dev and prod have a prefix too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STORAGE_AREAS, TMP_RETENTION_DAYS, UPLOAD_RETENTION_DAYS, stageInfo } from "../config.ts";
import { lifecycleRules } from "../storage.ts";

test("one expiry rule per area, at the area root", () => {
  assert.deepEqual(lifecycleRules(), [
    { id: "uploads-expiry", prefix: "uploads/", expiresIn: `${UPLOAD_RETENTION_DAYS} days` },
    { id: "tmp-expiry", prefix: "tmp/", expiresIn: `${TMP_RETENTION_DAYS} days` },
  ]);
});

test("every stage's keys fall under exactly one lifecycle rule of their area", () => {
  const rules = lifecycleRules();
  for (const name of ["dev", "prod", "pr-12"]) {
    const s = stageInfo(name);
    for (const area of STORAGE_AREAS) {
      const key = `${area}/${s.storagePrefix}voice/abc.webm`;
      const matching = rules.filter((r) => key.startsWith(r.prefix));
      assert.equal(matching.length, 1, key);
      assert.equal(matching[0]?.id, `${area}-expiry`, key);
    }
  }
});
