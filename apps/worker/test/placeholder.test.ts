// Placeholder worker for the first `dev` deploy (M0 step 4): one log line,
// then stays alive until SIGTERM. Step 5 replaces it with pg-boss jobs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("logs one structured line, stays alive, exits 0 on SIGTERM", async () => {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, STAGE: "test" } });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(child.exitCode, null, "worker exited early");
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const log = JSON.parse(lines[0]!) as { level?: unknown; stage?: unknown };
  assert.equal(log.level, "info");
  assert.equal(log.stage, "test");

  child.kill("SIGTERM");
  assert.equal(await exited, 0);
});
