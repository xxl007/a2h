// Task 2.7 / design D5: the JSON Schema export of every tool input and
// output, compared with the snapshots committed in json-schema/. Regenerate
// on purpose with UPDATE_SNAPSHOTS=1 and review the diff: a shape change is a
// spec change. The mcp tests (group 4) assert the registered schemas equal
// this export ("Tool schemas come from the export").
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { TOOL_SCHEMAS, toolJsonSchemas } from "../src/index.ts";

const dir = new URL("../json-schema/", import.meta.url);
const update = process.env.UPDATE_SNAPSHOTS === "1";
const exported = toolJsonSchemas();

describe("JSON Schema export, snapshot per tool input and output", () => {
  for (const [tool, { input, output }] of Object.entries(exported)) {
    for (const [io, schema] of [["input", input], ["output", output]] as const) {
      const file = new URL(`${tool}.${io}.json`, dir);
      test(`${tool} ${io} matches json-schema/${tool}.${io}.json`, () => {
        const text = JSON.stringify(schema, null, 2) + "\n";
        if (update) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, text);
        }
        assert.ok(existsSync(file), `snapshot missing: run UPDATE_SNAPSHOTS=1 pnpm --filter @a2h/protocol test`);
        assert.equal(text, readFileSync(file, "utf8"));
      });
      test(`${tool} ${io} is a closed top-level object (MCP inputSchema/outputSchema)`, () => {
        assert.equal(schema.type, "object");
        assert.equal(schema.additionalProperties, false);
        assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      });
    }
  }
  test("covers exactly the three A2H tools of this change", () => {
    assert.deepEqual(Object.keys(exported).sort(), ["check_requests", "find_humans", "request_human"]);
    assert.deepEqual(Object.keys(TOOL_SCHEMAS).sort(), Object.keys(exported).sort());
  });
  test("request_human input requires the manifest fields, never a principal (it comes from the connection)", () => {
    const input = exported.request_human.input as { required: string[]; properties: Record<string, unknown> };
    for (const f of ["to", "intent", "question", "bid_minor", "currency", "expires_at", "data_terms"]) assert.ok(input.required.includes(f), f);
    assert.equal("principal_id" in input.properties, false);
  });
});
