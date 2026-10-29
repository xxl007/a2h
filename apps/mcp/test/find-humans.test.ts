// Task 4.2: find_humans, one test per scenario of
// openspec/changes/m1-protocol-connector/specs/protocol/discovery/spec.md,
// against the real tools and the real seeded simulated set on Postgres 17.
import { existsSync, readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { FindHumansOutputSchema, ProfileSchema, type FindHumansOutput } from "@a2h/protocol";
import { SEED_PARTICIPANTS } from "../../../packages/db/seed/simulated.ts";
import type { DbConfig } from "../src/config.ts";
import { freshSchema, skipWithoutDocker, startPostgres, writeCounts, type PgContainer } from "./lib/db.ts";
import { modernClient, startA2h, texts, type RunningA2h } from "./lib/a2h.ts";

describe("find_humans", { skip: skipWithoutDocker() }, () => {
  let pgc: PgContainer;
  let db: DbConfig;
  let server: RunningA2h;
  let client: Client;

  before(async () => {
    pgc = await startPostgres();
    db = await freshSchema(pgc);
    server = await startA2h(db);
    client = await modernClient(server.url);
  });
  after(async () => {
    await client?.close();
    await server?.stop();
    pgc?.stop();
  });

  async function find(args: Record<string, unknown>): Promise<{ result: CallToolResult; out: FindHumansOutput }> {
    const result = (await client.callTool({ name: "find_humans", arguments: args }));
    assert.ok(!result.isError, `find_humans failed: ${texts(result).join(" | ")}`);
    return { result, out: FindHumansOutputSchema.parse(result.structuredContent) };
  }

  test("Scenario: Result shape: handles, topics with evidence, rating, latency, gross reserves, free lanes, verification; no identity", async () => {
    const { result, out } = await find({ topic: "patient information leaflets", request_type: "judgment" });
    assert.ok(out.results.length >= 1);
    for (const p of out.results) {
      assert.ok(ProfileSchema.safeParse(p).success, `strict profile shape: ${p.handle}`);
      assert.ok(p.topics.every((t) => typeof t.evidence === "string"));
      assert.ok(p.reserves.length >= 1);
      assert.equal(typeof p.identity_verified, "boolean");
      assert.ok(Array.isArray(p.free_lanes));
    }
    const everything = JSON.stringify(result);
    assert.doesNotMatch(everything, /@/, "no email address");
    assert.doesNotMatch(everything, /https?:\/\/|www\./i, "no URL");
    assert.doesNotMatch(everything, /\+?\d[\d\s().-]{8,}\d/, "no phone number");
    for (const seeded of SEED_PARTICIPANTS) {
      const name = seeded.display_label.replace(" (simulated)", "");
      assert.ok(!everything.includes(name), `no name (${seeded.handle})`);
      for (const part of name.split(" ")) assert.ok(!everything.includes(part), `no part of a name (${seeded.handle})`);
    }
  });

  test("Scenario: Display string matches the fields: 4.8 · 48 answers · 0 disputes · ~6h", async () => {
    const { out } = await find({ topic: "patient information leaflets", request_type: "judgment" });
    const mv = out.results.find((p) => p.handle === "sim-mv-7f3c");
    assert.ok(mv, "the leaflet reviewer is found");
    assert.deepEqual(mv.rating, { rating: 4.8, answers: 48, disputes_lost: 0, typical_latency_seconds: 6 * 3600 });
    assert.equal(mv.ranking_display, "4.8 · 48 answers · 0 disputes · ~6h");
  });

  test("Scenario: Maximum price excludes a profile (gross 3125 > max 3000)", async () => {
    const atLimit = await find({ topic: "patient information leaflets", request_type: "judgment", max_price_minor: 3125, currency: "EUR" });
    assert.ok(atLimit.out.results.some((p) => p.handle === "sim-mv-7f3c"), "present at 3125");
    const below = await find({ topic: "patient information leaflets", request_type: "judgment", max_price_minor: 3000, currency: "EUR" });
    assert.ok(!below.out.results.some((p) => p.handle === "sim-mv-7f3c"), "absent at 3000");
  });

  test("Scenario: Attested only: every result has a topic evidenced by more than self-declaration", async () => {
    const all = await find({ topic: "commercial kitchen equipment repair", request_type: "knowledge" });
    assert.ok(all.out.results.some((p) => p.handle === "sim-rc-8d14"), "the self-declared profile matches without the filter");
    const attested = await find({ topic: "commercial kitchen equipment repair", request_type: "knowledge", attested: true });
    assert.ok(!attested.out.results.some((p) => p.handle === "sim-rc-8d14"));
    for (const p of attested.out.results) assert.ok(p.topics.some((t) => t.evidence !== "self_declared"), p.handle);
  });

  test("Filters: only profiles that accept the request type; latency promise within the limit", async () => {
    // sim-mv-7f3c publishes `estimate` but does not accept it.
    const estimate = await find({ topic: "patient information leaflets", request_type: "estimate" });
    assert.ok(!estimate.out.results.some((p) => p.handle === "sim-mv-7f3c"));
    const fast = await find({ topic: "patient information leaflets", request_type: "judgment", latency: 3600 });
    assert.ok(!fast.out.results.some((p) => p.handle === "sim-mv-7f3c"), "a 6 h promise is not within 1 h");
    const slow = await find({ topic: "patient information leaflets", request_type: "judgment", latency: 6 * 3600 });
    assert.ok(slow.out.results.some((p) => p.handle === "sim-mv-7f3c"));
  });

  test("Ranking: results are ordered by the ranking, best topical fit first", async () => {
    const { out } = await find({ topic: "Would a patient find this diabetes leaflet alarming?", request_type: "judgment" });
    assert.equal(out.results[0]?.handle, "sim-mv-7f3c");
  });

  test("Scenario: Empty result: an empty list with a hint, not an error", async () => {
    const result = (await client.callTool({ name: "find_humans", arguments: { topic: "underwater basket weaving", request_type: "judgment" } }));
    assert.ok(!result.isError);
    const out = FindHumansOutputSchema.parse(result.structuredContent);
    assert.deepEqual(out.results, []);
    assert.match(out.hint ?? "", /widen|referral/i);
    assert.match(texts(result).join("\n"), /no /i);
  });

  test("Scenario: Nothing recorded for participants: no request, event, job or blocked-manifest row", async () => {
    const before = await writeCounts(db);
    const { out } = await find({ topic: "patient information leaflets", request_type: "judgment" });
    assert.ok(out.results.length >= 1);
    assert.deepEqual(await writeCounts(db), before);
    assert.deepEqual(before, { requests: 0, request_events: 0, blocked_manifests: 0, answers: 0 });
    // No job: the mcp service cannot enqueue one at all (no pg-boss anywhere in its dependencies); jobs are the worker's.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    assert.ok(!Object.keys(pkg.dependencies ?? {}).some((d) => d.includes("pg-boss")), "apps/mcp has no job queue client");
    assert.ok(!existsSync(new URL("../node_modules/pg-boss", import.meta.url)), "pg-boss is not even installed for apps/mcp");
  });

  test("Scenario: Gross reserve with fee metadata: net 2500 at 20% shows 3125 and fee 20", async () => {
    const { result, out } = await find({ topic: "patient information leaflets", request_type: "judgment" });
    assert.equal(out.fee_percent, 20);
    const mv = out.results.find((p) => p.handle === "sim-mv-7f3c")!;
    assert.deepEqual(
      mv.reserves.find((r) => r.request_type === "judgment"),
      { request_type: "judgment", reserve_gross_minor: 3125, currency: "EUR" },
    );
    assert.match(texts(result).join("\n"), /€31\.25/);
    assert.match(texts(result).join("\n"), /20%/);
  });

  test("Marked in discovery: simulated handles start with sim- and carry simulated: true", async () => {
    const { result, out } = await find({ topic: "patient information leaflets", request_type: "judgment" });
    for (const p of out.results) {
      assert.ok(p.handle.startsWith("sim-"));
      assert.equal(p.simulated, true);
    }
    assert.match(texts(result).join("\n"), /simulated/);
  });

  test("Invalid arguments are refused as schema_invalid, naming the field only", async () => {
    const result = (await client.callTool({ name: "find_humans", arguments: { topic: "x", request_type: "gossip" } }));
    assert.equal(result.isError, true);
    assert.match(texts(result).join("\n"), /schema_invalid/);
    assert.match(texts(result).join("\n"), /request_type/);
  });
});
