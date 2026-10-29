// Contract tests against a live stage for
// openspec/changes/m1-protocol-connector/specs/protocol/discovery/spec.md and the
// discovery side of specs/platform/participant-simulation/spec.md.
// One test per scenario, named after it. find_humans writes nothing, so this
// file costs the stage nothing.
// Run: A2H_MCP_URL=http://<alb>/pr-<n>/mcp pnpm --filter @a2h/tests contract
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { FindHumansOutputSchema, type FindHumansOutput } from "@a2h/protocol";
import { SEED_PARTICIPANTS } from "../../packages/db/seed/simulated.ts";
import { assertNothingCreatedFor, principalClient, serverNow, texts, type A2hClient, type Args } from "./a2h.ts";

/** Seed: sim-mv-7f3c, leaflets, judgment net 2500, 4.8 · 48 answers · 0 disputes · ~6h. */
const LEAFLETS = { topic: "patient information leaflets", request_type: "judgment" } as const;

describe("protocol/discovery (live)", () => {
  let c: A2hClient;
  before(async () => {
    c = await principalClient();
  });
  after(async () => {
    await c?.close();
  });

  async function find(args: Args): Promise<{ out: FindHumansOutput; result: CallToolResult }> {
    const result = (await c.client.callTool({ name: "find_humans", arguments: args }, { timeout: 30_000 }));
    assert.ok(!result.isError, `find_humans ${JSON.stringify(args)} is an error: ${texts(result)}`);
    return { out: FindHumansOutputSchema.parse(result.structuredContent), result };
  }

  test("Scenario: Result shape", async () => {
    const { out, result } = await find(LEAFLETS);
    assert.ok(out.results.length > 0, "the leaflet topic is covered by the seed");
    for (const r of out.results) {
      assert.match(r.handle, /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{4}$/);
      assert.equal(r.simulated, true, `${r.handle}: a preview holds simulated participants only`);
      assert.ok(r.topics.length > 0 && r.topics.every((t) => typeof t.evidence === "string"), `${r.handle}: topics with evidence labels`);
      assert.ok(r.rating, `${r.handle}: rating summary`);
      assert.equal(typeof r.latency_promise_seconds, "number", `${r.handle}: latency promise`);
      assert.ok(r.reserves.length > 0, `${r.handle}: gross reserve per accepted request type`);
      assert.ok(Array.isArray(r.free_lanes), `${r.handle}: free lanes`);
      assert.equal(typeof r.identity_verified, "boolean", `${r.handle}: verification status`);
    }
    // Nothing anywhere in the result (structured or text) holds identity or contact data.
    const everything = JSON.stringify(result);
    assert.doesNotMatch(everything, /[\w.+-]+@[\w-]+\.[\w.]+/, "an email address");
    assert.doesNotMatch(everything, /https?:\/\/|www\./i, "a URL");
    assert.doesNotMatch(everything, /\+?\d[\d ().-]{8,}\d/, "a phone number");
    for (const p of SEED_PARTICIPANTS) {
      for (const part of p.display_label.replace(" (simulated)", "").split(" ")) {
        assert.ok(!everything.includes(part), `the result names ${p.handle} ("${part}")`);
      }
    }
  });

  test("Scenario: Display string matches the fields", async () => {
    const { out } = await find(LEAFLETS);
    const mv = out.results.find((r) => r.handle === "sim-mv-7f3c");
    assert.ok(mv, "sim-mv-7f3c is in the leaflet results");
    assert.deepEqual(
      { rating: mv.rating.rating, answers: mv.rating.answers, disputes: mv.rating.disputes_lost, latency: mv.rating.typical_latency_seconds },
      { rating: 4.8, answers: 48, disputes: 0, latency: 6 * 3600 },
    );
    assert.equal(mv.ranking_display, "4.8 · 48 answers · 0 disputes · ~6h");
  });

  test("Scenario: Maximum price excludes a profile", async () => {
    const at = await find({ ...LEAFLETS, max_price_minor: 3125, currency: "EUR" });
    assert.ok(at.out.results.some((r) => r.handle === "sim-mv-7f3c"), "present at its gross reserve, 3125");
    const below = await find({ ...LEAFLETS, max_price_minor: 3000, currency: "EUR" });
    assert.ok(!below.out.results.some((r) => r.handle === "sim-mv-7f3c"), "absent at 3000");
    for (const r of below.out.results) {
      const judgment = r.reserves.find((x) => x.request_type === "judgment");
      assert.ok(judgment && judgment.reserve_gross_minor <= 3000, `${r.handle} exceeds the maximum price`);
    }
  });

  test("Scenario: Attested only", async () => {
    // sim-rc-8d14 (kitchen equipment repair) is self-declared only.
    const query = { topic: "commercial kitchen equipment repair", request_type: "knowledge" };
    const all = await find(query);
    assert.ok(all.out.results.some((r) => r.handle === "sim-rc-8d14"), "found without the filter");
    const attested = await find({ ...query, attested: true });
    assert.ok(!attested.out.results.some((r) => r.handle === "sim-rc-8d14"), "absent with attested: true");
    const broad = await find({ ...LEAFLETS, attested: true });
    for (const r of [...attested.out.results, ...broad.out.results]) {
      assert.ok(r.topics.some((t) => t.evidence !== "self_declared"), `${r.handle} has only self-declared topics`);
    }
  });

  test("Scenario: Empty result", async () => {
    const { out, result } = await find({ topic: "restoration of nineteenth-century harpsichord quills", request_type: "judgment" });
    assert.deepEqual(out.results, []);
    assert.ok(out.hint && out.hint.length > 0, "a hint to widen the filters or ask for a referral");
    assert.notEqual(result.isError, true);
  });

  test("Scenario: Nothing recorded for participants (observable part: no request exists for the handles found)", async () => {
    const since = serverNow();
    const { out } = await find({ topic: "residential conveyancing in England", request_type: "knowledge" });
    const handles = out.results.map((r) => r.handle);
    assert.ok(handles.length > 0);
    for (const h of handles) await assertNothingCreatedFor(c, h, since);
    // Events, jobs and blocked-manifest rows are not visible from outside:
    // apps/mcp/test/find-humans.test.ts "Scenario: Nothing recorded for participants".
  });

  test("Scenario: Gross reserve with fee metadata", async () => {
    const { out, result } = await find(LEAFLETS);
    assert.equal(out.fee_percent, 20, "the stage's fee rate (infra/config.ts FEE_RATE = 0.2)");
    const mv = out.results.find((r) => r.handle === "sim-mv-7f3c");
    const judgment = mv?.reserves.find((x) => x.request_type === "judgment");
    assert.equal(judgment?.reserve_gross_minor, 3125, "net 2500 at 20% is gross 3125");
    assert.equal(judgment?.currency, "EUR");
    assert.match(texts(result), /20 ?%/);
  });
});

describe("platform/participant-simulation, discovery side (live)", () => {
  let c: A2hClient;
  before(async () => {
    c = await principalClient();
  });
  after(async () => {
    await c?.close();
  });

  async function handlesFor(topic: string, request_type: string): Promise<string[]> {
    const result = (await c.client.callTool({ name: "find_humans", arguments: { topic, request_type } }, { timeout: 30_000 }));
    assert.ok(!result.isError, texts(result));
    return FindHumansOutputSchema.parse(result.structuredContent).results.map((r) => r.handle);
  }

  // Every seeded participant, found by its own first topic and an intent it accepts.
  const queries = SEED_PARTICIPANTS.map((p) => ({
    handle: p.handle,
    topic: p.topics[0]!.topic,
    intent: p.rules.types.find((t) => t.accepted)!.intent,
  }));

  test("Scenario: Seed on a preview", async () => {
    assert.equal(queries.length, 12, "the seed holds twelve simulated participants");
    for (const q of queries) {
      const handles = await handlesFor(q.topic, q.intent);
      assert.ok(handles.includes(q.handle), `${q.handle} not found for "${q.topic}" (${q.intent}): ${JSON.stringify(handles)}`);
    }
  });

  test("Scenario: Redeploy (the preview redeploys on every push: each handle comes back once)", async () => {
    for (const q of queries) {
      const handles = await handlesFor(q.topic, q.intent);
      assert.equal(new Set(handles).size, handles.length, `duplicate handles for "${q.topic}": ${JSON.stringify(handles)}`);
      assert.equal(handles.filter((h) => h === q.handle).length, 1);
    }
  });

  test("Scenario: Marked in discovery and in answers (discovery side: every handle starts with sim-)", async () => {
    for (const q of queries) {
      for (const h of await handlesFor(q.topic, q.intent)) assert.match(h, /^sim-/, `${h} is not marked simulated`);
    }
    // The label ("(simulated)") is revealed on acceptance and the answer's
    // `simulated: true` in check_requests: request-flows.test.ts.
  });
});
