// Task 3.1: the Drizzle schema, checked without a database. The database
// behaviour of the same constraints is in constraints.test.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as protocol from "@a2h/protocol";
import * as schema from "../src/schema.ts";
import { MIGRATIONS_DIR, migrationFiles } from "./lib/postgres.ts";

const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => {
  try {
    getTableConfig(v as PgTable);
    return true;
  } catch {
    return false;
  }
});
const byName = new Map(tables.map((t) => [getTableConfig(t).name, getTableConfig(t)]));
const allSql = migrationFiles().map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")).join("\n");

describe("task 3.1: tables", () => {
  test("the tables the change names exist", () => {
    for (const name of ["participants", "profiles", "rules", "requests", "request_events", "blocked_manifests", "answers", "signing_keys", "schema_migrations"]) {
      assert.ok(byName.has(name), `table ${name}`);
    }
  });

  test("m1-hosted-connector group 3: principals, principal_policies, rate_limit_windows exist (design D4, D5)", () => {
    for (const name of ["principals", "principal_policies", "rate_limit_windows"]) {
      assert.ok(byName.has(name), `table ${name}`);
    }
  });

  test("tables are not pinned to a schema: the stage's search_path places them (public on dev, pr_<n> on previews)", () => {
    for (const [name, t] of byName) assert.equal(t.schema, undefined, name);
    assert.doesNotMatch(allSql, /"public"\./, "migration SQL names no schema");
  });
});

describe("Scenario: Blocked row (no column can hold the question)", () => {
  const t = byName.get("blocked_manifests")!;
  test("columns are ids, stage, code and time, nothing else", () => {
    assert.deepEqual(t.columns.map((c) => c.name).sort(), ["at", "code", "id", "participant_id", "principal_id", "request_id", "stage"]);
  });
  test("no column has an unbounded type; every string column holds at most a short code or id (64)", () => {
    for (const c of t.columns) {
      const type = c.getSQLType();
      assert.doesNotMatch(type, /^(text|jsonb?|bytea)/, `${c.name}: ${type}`);
      const m = /^(?:varchar|character varying|char|character)\((\d+)\)$/.exec(type);
      if (m) assert.ok(Number(m[1]) <= protocol.OPAQUE_ID_MAX_LENGTH, `${c.name}: ${type}`);
      else assert.match(type, /^(bigint|integer|timestamp with time zone)$/, `${c.name}: ${type}`);
    }
  });
  test("the code column accepts exactly the participant block codes (constraint built from @a2h/protocol)", () => {
    const check = t.checks.map((c) => c.name);
    assert.ok(check.includes("blocked_manifests_code_known"), check.join(","));
    for (const code of protocol.PARTICIPANT_BLOCK_CODES) assert.ok(allSql.includes(`'${code}'`), code);
  });
});

describe("money columns: integers in minor units next to a currency", () => {
  test("every *_minor column is integer and its table has a 3-character currency column", () => {
    let seen = 0;
    for (const [name, t] of byName) {
      const money = t.columns.filter((c) => c.name.endsWith("_minor"));
      if (money.length === 0) continue;
      seen += money.length;
      for (const c of money) assert.equal(c.getSQLType(), "integer", `${name}.${c.name}`);
      const currency = t.columns.find((c) => c.name === "currency");
      assert.ok(currency, `${name} has currency`);
      assert.match(currency.getSQLType(), /^(char|character)\(3\)$/, `${name}.currency`);
      assert.equal(currency.notNull, true, `${name}.currency not null`);
    }
    assert.ok(seen >= 6, "requests.bid_minor, requests.cleared_minor, rule_types.reserve_net_minor, principal_policies.*_minor");
  });
  test("no float or numeric column holds money", () => {
    for (const [name, t] of byName)
      for (const c of t.columns)
        if (/real|double|numeric/.test(c.getSQLType())) assert.doesNotMatch(c.name, /minor|amount|price|bid|reserve/, `${name}.${c.name}`);
  });
});

describe("principal policies hold exactly the policy fields of @a2h/protocol (spec request-approval \"Principal's own policy applies\")", () => {
  test("every ValidationPolicy field but the platform's fee rate is a column; nothing else but the key and updated_at", () => {
    const t = byName.get("principal_policies")!;
    const policyFields = Object.keys(protocol.ValidationPolicySchema.shape).filter((k) => k !== "fee_rate");
    assert.deepEqual(t.columns.map((c) => c.name).sort(), [...policyFields, "principal_id", "updated_at"].sort());
    assert.equal(t.columns.find((c) => c.name === "ask_first_above_minor")?.notNull, false, "ask_first_above_minor nullable");
    for (const c of t.columns) if (c.name !== "ask_first_above_minor") assert.equal(c.notNull, true, c.name);
  });
  test("principals hold the protocol Principal fields and a creation time", () => {
    const t = byName.get("principals")!;
    assert.deepEqual(t.columns.map((c) => c.name).sort(), [...Object.keys(protocol.PrincipalSchema.shape), "created_at"].sort());
  });
});

describe("enums and codes come from @a2h/protocol", () => {
  const cases: [string, readonly string[]][] = [
    ["request status", protocol.REQUEST_STATUSES],
    ["intent", protocol.INTENTS],
    ["signing key status", protocol.SIGNING_KEY_STATUSES],
    ["persona", protocol.SIMULATED_PERSONAS],
    ["actor", protocol.ActorSchema.options],
    ["lane", protocol.LaneSchema.options],
    ["delivery outcome", protocol.DELIVERY_OUTCOMES],
    ["principal identity mode", protocol.PrincipalSchema.shape.identity_mode.options],
    ["rate-limit window", protocol.RATE_LIMIT_WINDOWS],
  ];
  for (const [what, values] of cases) {
    test(`${what}: every value appears in a check constraint`, () => {
      for (const v of values) assert.ok(allSql.includes(`'${v}'`), `${what} ${v}`);
    });
  }
  test("patterns are the protocol's (request id, handle, opaque id, signature, public key)", () => {
    for (const re of [protocol.REQUEST_ID_PATTERN, protocol.HANDLE_PATTERN, protocol.OPAQUE_ID_PATTERN, protocol.SIGNATURE_PATTERN, protocol.PUBLIC_KEY_PATTERN]) {
      assert.ok(allSql.includes(`'${re.source}'`), re.source);
    }
  });
});

test("committed migrations are what drizzle-kit generates from src/schema.ts (no drift)", () => {
  const out = mkdtempSync(join(tmpdir(), "a2h-db-gen-"));
  try {
    cpSync(MIGRATIONS_DIR, out, { recursive: true });
    const before = readdirSync(out, { recursive: true }).sort();
    const log = execFileSync("pnpm", ["exec", "drizzle-kit", "generate"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, DRIZZLE_OUT: out },
      encoding: "utf8",
    });
    assert.deepEqual(readdirSync(out, { recursive: true }).sort(), before, `drizzle-kit generated new files:\n${log}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

describe("m1-hosted-connector task 3.1: packages/db holds no authorization server and nothing network-facing", () => {
  const root = new URL("..", import.meta.url).pathname;
  test("runtime dependencies are the protocol, Drizzle and the Postgres driver only (no Better Auth, no AWS SDK)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@a2h/protocol", "drizzle-orm", "pg"]);
  });
  test("no source file imports Better Auth, an AWS SDK, an HTTP module or calls fetch", () => {
    const files = (readdirSync(join(root, "src"), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length >= 3, files.join(","));
    for (const f of files) {
      const src = readFileSync(join(root, "src", f), "utf8");
      assert.doesNotMatch(src, /from\s+["'](better-auth|@better-auth\/[^"']*|@aws-sdk\/[^"']*|node:https?|https?|undici)["']/, f);
      assert.doesNotMatch(src, /\bfetch\s*\(/, f);
    }
  });
});
