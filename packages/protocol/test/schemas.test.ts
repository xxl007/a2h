// Spec protocol/schemas: "Fixture pair per schema", "Fractional amount
// rejected", and the structural guarantees the other specs lean on.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type * as z from "zod";
import * as protocol from "../src/index.ts";
import { fixtures, omit, referenceEnvelope, referenceManifest, referenceProfile } from "./fixtures.ts";

const schemas = protocol as unknown as Record<string, z.ZodType>;
/** Every exported schema: PascalCase names ending in Schema. */
const schemaNames = Object.keys(protocol).filter((k) => /^[A-Z]\w*Schema$/.test(k));

describe("Scenario: Fixture pair per schema", () => {
  for (const [name, { pass, fail, path }] of Object.entries(fixtures)) {
    test(`${name}: passing fixture accepted, failing fixture rejected at ${JSON.stringify(path)}`, () => {
      const schema = schemas[name];
      assert.ok(schema, `${name} is exported`);
      const ok = schema.safeParse(pass);
      assert.ok(ok.success, `${name} rejected its passing fixture: ${ok.success ? "" : JSON.stringify(ok.error.issues)}`);
      const ko = schema.safeParse(fail);
      assert.equal(ko.success, false, `${name} accepted its failing fixture`);
      assert.deepEqual(ko.error?.issues[0]?.path, path);
    });
  }

  test("every exported *Schema has a fixture pair", () => {
    const missing = schemaNames.filter((k) => !(k in fixtures));
    assert.deepEqual(missing, []);
  });
});

test("Scenario: Fractional amount rejected (manifest with bid_minor: 30.5 is schema-invalid)", () => {
  const r = protocol.ManifestSchema.safeParse({ ...referenceManifest, bid_minor: 30.5 });
  assert.equal(r.success, false);
});

describe("Money is integers in minor units with a currency", () => {
  test("negative and unsafe amounts are rejected where an amount cannot be negative", () => {
    assert.equal(protocol.ManifestSchema.safeParse({ ...referenceManifest, bid_minor: -1 }).success, false);
    assert.equal(protocol.ManifestSchema.safeParse({ ...referenceManifest, bid_minor: 2 ** 53 }).success, false);
  });
  test("an amount without its currency is rejected", () => {
    assert.equal(protocol.ManifestSchema.safeParse(omit(referenceManifest, "currency")).success, false);
  });
  test("every money field in every exported schema is named *_minor and sits next to a currency", () => {
    // Walk the JSON Schema of each object schema: integer fields ending in
    // _minor must have a sibling `currency`; no field is called amount/price.
    const offenders: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      const props = n.properties as Record<string, Record<string, unknown>> | undefined;
      if (props) {
        for (const [key, value] of Object.entries(props)) {
          if (/^(amount|price|bid|reserve|fee|held|cleared)$/.test(key)) offenders.push(`${where}.${key} lacks _minor`);
          if (key.endsWith("_minor")) {
            if (value.type !== "integer") offenders.push(`${where}.${key} is not an integer`);
            if (!("currency" in props)) offenders.push(`${where}.${key} has no sibling currency`);
          }
        }
      }
      for (const [k, v] of Object.entries(n)) walk(v, `${where}.${k}`);
    };
    for (const name of schemaNames) {
      walk(protocol.toJsonSchema(schemas[name]!), name);
    }
    // FindHumansInput: max_price_minor is optional, its currency is required with it (refined).
    assert.deepEqual(offenders, []);
  });
});

describe("Answer envelope is complete or rejected", () => {
  test("Unsigned answer: no signature is schema-invalid", () => {
    assert.equal(protocol.AnswerEnvelopeSchema.safeParse(omit(referenceEnvelope, "signature")).success, false);
  });
  test("Attestation missing or false", () => {
    assert.equal(protocol.AnswerEnvelopeSchema.safeParse(omit(referenceEnvelope, "answered_personally")).success, false);
    assert.equal(protocol.AnswerEnvelopeSchema.safeParse({ ...referenceEnvelope, answered_personally: false }).success, false);
  });
  test("Confidence out of range: 0 and 6 rejected, 1..5 accepted", () => {
    for (const c of [0, 6, 2.5]) assert.equal(protocol.AnswerEnvelopeSchema.safeParse({ ...referenceEnvelope, confidence: c }).success, false, `confidence ${c}`);
    for (const c of [1, 2, 3, 4, 5]) assert.ok(protocol.AnswerEnvelopeSchema.safeParse({ ...referenceEnvelope, confidence: c }).success, `confidence ${c}`);
  });
  test("Body does not match the intent: judgment with an estimate and no verdict", () => {
    const schema = protocol.answerEnvelopeSchemaFor("judgment");
    const r = schema.safeParse({ ...referenceEnvelope, body: { estimate: 12, range: { low: 8, high: 15 } } });
    assert.equal(r.success, false);
    assert.ok(schema.safeParse(referenceEnvelope).success);
  });
  test("every intent has its body schema, and cant_tell is accepted on every verdict-bearing intent", () => {
    assert.deepEqual(Object.keys(protocol.AnswerBodySchemas).sort(), [...protocol.INTENTS].sort());
    assert.ok(protocol.VerificationBodySchema.safeParse({ verdict: "cant_tell" }).success);
    assert.ok(protocol.JudgmentBodySchema.safeParse({ verdict: "cant_tell" }).success);
  });
  test("knowledge needs text or voice; authorisation edit needs its text; estimate range is ordered", () => {
    assert.equal(protocol.KnowledgeBodySchema.safeParse({}).success, false);
    assert.equal(protocol.AuthorisationBodySchema.safeParse({ decision: "edit" }).success, false);
    assert.ok(protocol.AuthorisationBodySchema.safeParse({ decision: "edit", edit: "Make it 20 days." }).success);
    assert.equal(protocol.EstimateBodySchema.safeParse({ estimate: 12, range: { low: 15, high: 8 } }).success, false);
  });
});

describe("Discovery results carry no identity", () => {
  test("a profile with any extra field (name, email, url) is rejected", () => {
    for (const extra of [{ name: "Maria V." }, { email: "mv@example.org" }, { url: "https://example.org" }, { display_label: "M. V." }]) {
      assert.equal(protocol.ProfileSchema.safeParse({ ...referenceProfile, ...extra }).success, false, JSON.stringify(extra));
    }
  });
  test("max_price_minor without a currency is rejected", () => {
    assert.equal(protocol.FindHumansInputSchema.safeParse({ topic: "x", request_type: "judgment", max_price_minor: 3000 }).success, false);
  });
});

describe("Blocked manifests hold codes only", () => {
  test("a blocked-manifest record with the question is rejected", () => {
    const pass = fixtures.BlockedManifestSchema!.pass as object;
    assert.equal(protocol.BlockedManifestSchema.safeParse({ ...pass, question: "Is this alarming?" }).success, false);
  });
});

describe("Manifest lanes", () => {
  test("a free-lane manifest has bid 0 and names the free lane; a paid one bids more than 0", () => {
    assert.ok(protocol.ManifestSchema.safeParse({ ...referenceManifest, lane: "free", free_lane: "own_publications", bid_minor: 0 }).success);
    assert.equal(protocol.ManifestSchema.safeParse({ ...referenceManifest, lane: "free", bid_minor: 0 }).success, false);
    assert.equal(protocol.ManifestSchema.safeParse({ ...referenceManifest, lane: "free", free_lane: "own_publications", bid_minor: 100 }).success, false);
    assert.equal(protocol.ManifestSchema.safeParse({ ...referenceManifest, bid_minor: 0 }).success, false);
  });
  test("an empty or whitespace-only question is rejected", () => {
    assert.equal(protocol.ManifestSchema.safeParse({ ...referenceManifest, question: "   " }).success, false);
  });
});
