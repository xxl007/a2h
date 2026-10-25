// The deployment adapter (apps/worker/infra/env.ts): the only code that knows
// how this deployment passes database credentials (infra/README.md: DB_HOST,
// DB_PORT, DB_NAME, DB_USER, DB_PASSWORD from Secrets Manager, DB_SCHEMA,
// and DB_CA_BUNDLE baked into the image).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbConfigFromEnv } from "../infra/env.ts";

const PASSWORD = "s3cr3t-p@ss:w/rd#?%&=+ é";

const base = {
  DB_HOST: "a2h-dev.cluster-xyz.eu-west-3.rds.amazonaws.com",
  DB_PORT: "5432",
  DB_NAME: "a2h",
  DB_USER: "pr_12",
  DB_PASSWORD: PASSWORD,
  DB_SCHEMA: "pr_12",
};

function silenceAndWatchConsole(t: TestContext): string[] {
  const seen: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    });
  }
  return seen;
}

test("builds the connection string, URL-encoding user and password", (t) => {
  const seen = silenceAndWatchConsole(t);
  const config = dbConfigFromEnv({ ...base });
  const url = new URL(config.connectionString);
  assert.equal(url.protocol, "postgres:");
  assert.equal(url.hostname, base.DB_HOST);
  assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/a2h");
  assert.equal(decodeURIComponent(url.username), "pr_12");
  assert.equal(decodeURIComponent(url.password), PASSWORD);
  assert.equal(url.search, "", "no sslmode or other options in the string");
  assert.equal(config.schema, "pr_12");
  assert.deepEqual(seen, [], "the adapter logs nothing");
});

test("no DB_CA_BUNDLE (local tests): no TLS", (t) => {
  silenceAndWatchConsole(t);
  assert.equal(dbConfigFromEnv({ ...base }).ssl, false);
  assert.equal(dbConfigFromEnv({ ...base, DB_CA_BUNDLE: "" }).ssl, false);
});

test("DB_CA_BUNDLE pointing at a file: TLS that verifies the server certificate", (t) => {
  silenceAndWatchConsole(t);
  const dir = mkdtempSync(join(tmpdir(), "a2h-ca-"));
  const path = join(dir, "global-bundle.pem");
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  writeFileSync(path, pem);
  const { ssl } = dbConfigFromEnv({ ...base, DB_CA_BUNDLE: path });
  assert.deepEqual(ssl, { ca: pem, rejectUnauthorized: true });
});

test("DB_CA_BUNDLE set but the file is missing: refuse to start rather than drop TLS", (t) => {
  const seen = silenceAndWatchConsole(t);
  assert.throws(
    () => dbConfigFromEnv({ ...base, DB_CA_BUNDLE: "/nonexistent/global-bundle.pem" }),
    (error: Error) => {
      assert.match(error.message, /DB_CA_BUNDLE/);
      assert.ok(!error.message.includes(PASSWORD));
      return true;
    },
  );
  assert.deepEqual(seen, []);
});

test("DB_PORT defaults to 5432", (t) => {
  silenceAndWatchConsole(t);
  const withoutPort: Record<string, string> = { ...base };
  delete withoutPort["DB_PORT"];
  assert.equal(new URL(dbConfigFromEnv(withoutPort).connectionString).port, "5432");
});

test("missing or invalid variables fail by name, never echoing the password", (t) => {
  const seen = silenceAndWatchConsole(t);
  const cases: Array<[Record<string, string>, RegExp]> = [];
  for (const name of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SCHEMA"] as const) {
    const env: Record<string, string> = { ...base };
    delete env[name];
    cases.push([env, new RegExp(name)]);
    cases.push([{ ...base, [name]: "" }, new RegExp(name)]);
  }
  cases.push([{ ...base, DB_PORT: "54x2" }, /DB_PORT/]);
  cases.push([{ ...base, DB_PORT: "70000" }, /DB_PORT/]);
  // pg-boss interpolates the schema name into SQL: only plain identifiers.
  for (const bad of ["pr_12; drop table x", "Public", "pr-12", "1abc", "a".repeat(64), '"x"']) {
    cases.push([{ ...base, DB_SCHEMA: bad }, /DB_SCHEMA/]);
  }
  for (const [env, expected] of cases) {
    assert.throws(
      () => dbConfigFromEnv(env),
      (error: Error) => {
        assert.match(error.message, expected);
        assert.ok(!error.message.includes(PASSWORD), "password in error message");
        return true;
      },
      JSON.stringify(Object.keys(env)),
    );
  }
  assert.deepEqual(seen, []);
});

test("public is an accepted schema (dev and prod stages)", (t) => {
  silenceAndWatchConsole(t);
  assert.equal(dbConfigFromEnv({ ...base, DB_SCHEMA: "public" }).schema, "public");
});
