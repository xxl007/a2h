// The running worker (tasks 5.2 to 5.6 wired together through pg-boss):
// a request to a simulated participant is delivered, simulated and answered
// without anyone calling a handler by hand; the expire queue is scheduled;
// on prod no simulate (or deliver) queue exists. Spec
// platform/participant-simulation "Prompt answer" (end to end), "Nothing on
// production", "No outbound traffic".
import { after, before, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startWorker, type RunningWorker } from "../src/worker.ts";
import type { WorkerLogLine } from "../src/log.ts";
import { createRequest, statusOf } from "./lib/requests.ts";
import { JOBS_SCHEMA, skipWithoutDocker, startStageDb, testConfig, testSigningKey, type StageDb } from "./lib/stage-db.ts";

const skip = skipWithoutDocker();
const SRC = new URL("../src/", import.meta.url).pathname;

async function until<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Every outbound connection the process opens while `fn` runs: host and port. */
function watchOutbound(t: TestContext): { connections: string[]; fetches: number; httpRequests: number } {
  const seen = { connections: [] as string[], fetches: 0, httpRequests: 0 };
  const original = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, "connect", function (this: net.Socket, ...args: unknown[]) {
    const [first, second] = args as [unknown, unknown];
    const target =
      typeof first === "object" && first !== null
        ? `${(first as { host?: string; path?: string }).host ?? (first as { path?: string }).path ?? "?"}:${(first as { port?: number }).port ?? ""}`
        : `${typeof second === "string" ? second : "localhost"}:${String(first)}`;
    seen.connections.push(target);
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  });
  t.mock.method(globalThis, "fetch", () => {
    seen.fetches += 1;
    return Promise.reject(new Error("no network in the simulator"));
  });
  for (const mod of [http, https]) {
    for (const m of ["request", "get"] as const) {
      t.mock.method(mod, m, () => {
        seen.httpRequests += 1;
        throw new Error("no network in the simulator");
      });
    }
  }
  return seen;
}

describe("the running worker", { skip }, () => {
  let stage: StageDb;
  before(async () => {
    stage = await startStageDb();
    // Short persona delays for the test run (the seed's are 15 to 100 s).
    await stage.admin.query(`UPDATE simulated_personas SET delay_seconds = 1`);
  });
  after(async () => {
    await stage?.stop();
  });

  test("Scenario: Prompt answer, end to end through the queues, with Scenario: No outbound traffic", async (t) => {
    const outbound = watchOutbound(t);
    const logs: WorkerLogLine[] = [];
    const key = testSigningKey("a2h-pr-12-run0000000001");
    let worker: RunningWorker | undefined;
    try {
      worker = await startWorker({
        config: testConfig(stage.db, { signing: key }),
        log: (l) => logs.push(l),
        dispatchIntervalMs: 200,
        pollingIntervalSeconds: 0.5,
      });
      // The stage key is recorded as the active platform key at start.
      const { rows } = await stage.admin.query(`SELECT status FROM signing_keys WHERE key_id = $1`, [key.key_id]);
      assert.equal(rows[0]?.status, "active");

      const prompt = await createRequest(stage.admin, { handle: "sim-mv-7f3c", intent: "judgment", bid_minor: 3500 });
      const declining = await createRequest(stage.admin, { handle: "sim-rc-8d14", intent: "knowledge", bid_minor: 3200 });
      await until("the prompt persona's answer", async () => (await statusOf(stage.admin, prompt.id)) === "answered");
      await until("the declining persona's decline", async () => (await statusOf(stage.admin, declining.id)) === "declined");
    } finally {
      await worker?.stop();
    }
    // No email (the worker has no mailer), no HTTP, no fetch; every socket went to this stage's database.
    assert.equal(outbound.fetches, 0, "fetch called");
    assert.equal(outbound.httpRequests, 0, "http(s) request made");
    const port = new URL(stage.db.connectionString).port;
    const elsewhere = outbound.connections.filter((c) => c !== `127.0.0.1:${port}`);
    assert.deepEqual(elsewhere, [], "connections other than the stage database");
    assert.ok(outbound.connections.length > 0, "the watcher saw the database connections");
    const all = JSON.stringify(logs);
    assert.ok(!all.includes("leaflet") && !all.includes("(simulated)"), "no question or answer text in logs");
  });

  test("the expire queue is scheduled every minute", async () => {
    const worker = await startWorker({ config: testConfig(stage.db, { signing: testSigningKey("a2h-pr-12-run0000000002") }), log: () => undefined });
    try {
      const { rows } = await stage.admin.query(`SELECT name, cron FROM ${JOBS_SCHEMA}.schedule`);
      assert.deepEqual(rows, [{ name: "expire", cron: "* * * * *" }]);
    } finally {
      await worker.stop();
    }
  });

  test("Scenario: Nothing on production (the simulator job is not registered)", async () => {
    const logs: WorkerLogLine[] = [];
    const r = await createRequest(stage.admin, { handle: "sim-ol-6a23", intent: "judgment", bid_minor: 4000 });
    // A separate jobs schema, as a fresh prod database would have.
    await stage.admin.query(`CREATE SCHEMA prod_jobs AUTHORIZATION pr_12`);
    const worker = await startWorker({
      config: testConfig({ ...stage.db, jobsSchema: "prod_jobs" }, { stage: "prod", simulatorEnabled: false, signing: testSigningKey("a2h-prod-run000000001") }),
      log: (l) => logs.push(l),
      dispatchIntervalMs: 100,
      pollingIntervalSeconds: 0.5,
    });
    try {
      await sleep(1500);
      const queues = (await stage.admin.query(`SELECT name FROM prod_jobs.queue ORDER BY name`)).rows.map((q: { name: string }) => q.name);
      assert.ok(!queues.includes("simulate"), `queues: ${queues.join(",")}`);
      assert.ok(!queues.includes("deliver"), `queues: ${queues.join(",")}`);
      assert.ok(queues.includes("expire"), "the lifecycle still runs on prod");
      // Nothing is delivered or simulated, and no key is recorded for signing simulated answers.
      assert.equal((await stage.admin.query(`SELECT count(*)::int AS n FROM request_deliveries WHERE request_id = $1`, [r.id])).rows[0].n, 0);
      assert.equal(await statusOf(stage.admin, r.id), "sent");
      assert.equal((await stage.admin.query(`SELECT count(*)::int AS n FROM signing_keys WHERE key_id = 'a2h-prod-run000000001'`)).rows[0].n, 0);
      assert.ok(logs.some((l) => l.msg === "simulator disabled"));
    } finally {
      await worker.stop();
    }
  });
});

test("Scenario: No outbound traffic (source): the worker has no mailer, no HTTP client, no AWS SDK, no model client", () => {
  const files = readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 5);
  const forbidden = [
    /from\s+["']node:https?["']/,
    /from\s+["'](?:http|https|undici|axios|node-fetch|nodemailer)["']/,
    /\bfetch\s*\(/,
    /@aws-sdk\//,
    /@a2h\/email/,
    /anthropic|openai/i,
  ];
  for (const f of files) {
    const text = readFileSync(join(SRC, f), "utf8");
    for (const re of forbidden) assert.doesNotMatch(text, re, `${f}: ${re}`);
  }
});
