// Task 5.1 (design D2): the web app's database. On AWS it is the Data API
// driver (infra/db.ts), exercised on the preview; here the same packages/db
// queries run through a node-postgres Drizzle instance logged in the way a
// preview logs in (role pr_<n>, search_path set on the role), so no statement
// names the schema.
import { ensurePrincipal, principalWithPolicy, type PrincipalsDb } from "@a2h/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { checkSchema, createDataApiDatabase, dataApiConfigFromEnv } from "../infra/db";
import { createStageSchema } from "./lib/postgres";

const adminUrl = inject("pgAdminUrl");
const SCHEMA = "pr_51";
const POLICY = {
  currency: "EUR",
  monthly_budget_minor: 50_000,
  per_request_cap_minor: 6_000,
  ask_first_above_minor: null,
  daily_request_limit: 50,
  throttled_daily_limit: 5,
};

const env = {
  DB_CLUSTER_ARN: "arn:aws:rds:eu-west-3:123456789012:cluster:a2h-dev-databasecluster-abc",
  DB_SECRET_ARN: "arn:aws:secretsmanager:eu-west-3:123456789012:secret:a2h/pr-51/db-AbC123",
  DB_NAME: "a2h",
  DB_SCHEMA: "pr_51",
};

describe("dataApiConfigFromEnv", () => {
  test("reads the cluster, the secret, the database and the schema", () => {
    expect(dataApiConfigFromEnv(env)).toEqual({ clusterArn: env.DB_CLUSTER_ARN, secretArn: env.DB_SECRET_ARN, database: "a2h", schema: "pr_51" });
  });
  test("refuses anything else, naming the variable and never the value", () => {
    for (const [name, bad] of [
      ["DB_CLUSTER_ARN", "not-an-arn"],
      ["DB_SECRET_ARN", "arn:aws:s3:::bucket"],
      ["DB_NAME", "a2h; drop"],
      ["DB_SCHEMA", "pr-51"],
    ] as const) {
      expect(() => dataApiConfigFromEnv({ ...env, [name]: bad })).toThrow(new RegExp(name));
      try {
        dataApiConfigFromEnv({ ...env, [name]: bad });
      } catch (e) {
        expect((e as Error).message).not.toContain(bad);
      }
    }
    expect(() => dataApiConfigFromEnv({ ...env, DB_SECRET_ARN: "" })).toThrow(/DB_SECRET_ARN is not set/);
  });
  test("builds a Data API Drizzle database without calling AWS", () => {
    const db = createDataApiDatabase(dataApiConfigFromEnv(env));
    expect(typeof db.select).toBe("function");
  });
});

describe.skipIf(!adminUrl)("packages/db queries on the web side (node-postgres stand-in for the Data API)", () => {
  let pool: pg.Pool;
  let db: PrincipalsDb;

  beforeAll(async () => {
    const url = await createStageSchema(adminUrl, SCHEMA);
    pool = new pg.Pool({ connectionString: url, max: 4 });
    db = drizzle(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  test("the login lands in the stage schema (checkSchema passes; a wrong expectation fails)", async () => {
    await expect(checkSchema(db, SCHEMA)).resolves.toBeUndefined();
    await expect(checkSchema(db, "public")).rejects.toThrow(/does not resolve to DB_SCHEMA/);
  });

  test("ensurePrincipal then principalWithPolicy read back the principal and its policy", async () => {
    const stored = await ensurePrincipal(db, "UsErId0123456789abcdefABCDEF0123", { policy: POLICY });
    expect(stored.principal).toEqual({ principal_id: "UsErId0123456789abcdefABCDEF0123", identity_mode: "real_name", verified: false });
    expect(stored.policy).toEqual(POLICY);
    expect(await principalWithPolicy(db, "UsErId0123456789abcdefABCDEF0123")).toEqual(stored);
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${SCHEMA}.principals`);
    expect(rows[0]!.n).toBe(1);
  });
});
