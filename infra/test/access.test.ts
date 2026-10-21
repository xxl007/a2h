// Contract amendment 1 (tasks.md): per-PR database login and scoped storage
// on previews. Pure mapping only; the SST wiring is in database.ts and mcp.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dbCredentials,
  prDbSecretName,
  prDbUser,
  secretValueFrom,
  storageAccess,
} from "../access.ts";
import { stageInfo } from "../config.ts";

const ACCOUNT = "123456789012";
const MASTER_SECRET_ARN = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:DatabaseProxySecret-3f1c9a7-AbCdEf`;
const PR12_SECRET_ARN = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:a2h/pr-12/db-Xy12Zq`;

test("pr login names: user pr_<n>, secret a2h/pr-<n>/db", () => {
  const pr = stageInfo("pr-12");
  assert.equal(prDbUser(pr), "pr_12");
  assert.equal(prDbSecretName(pr), "a2h/pr-12/db");
  // The login owns the stage's schema (pr-schema.sh: AUTHORIZATION pr_<n>).
  assert.equal(prDbUser(pr), pr.dbSchema);
  for (const s of ["dev", "prod"]) {
    assert.throws(() => prDbUser(stageInfo(s)), /pr-<n>/, s);
    assert.throws(() => prDbSecretName(stageInfo(s)), /pr-<n>/, s);
  }
});

test("valueFrom has the exact <secretArn>:password:: form", () => {
  assert.equal(secretValueFrom(PR12_SECRET_ARN, "password"), `${PR12_SECRET_ARN}:password::`);
  assert.throws(() => secretValueFrom("a2h/pr-12/db", "password"), /ARN/);
  assert.throws(() => secretValueFrom(`${PR12_SECRET_ARN}:password::`, "password"), /ARN/);
});

test("pr-12: DB_USER=pr_12, DB_PASSWORD from a2h/pr-12/db, never in plain environment", () => {
  const creds = dbCredentials(stageInfo("pr-12"), { kind: "pr-login", secretArn: PR12_SECRET_ARN });
  assert.deepEqual(creds, {
    environment: { DB_USER: "pr_12" },
    ssm: { DB_PASSWORD: `${PR12_SECRET_ARN}:password::` },
  });
  assert.ok(!("DB_PASSWORD" in creds.environment));
});

test("pr stages never reference the Aurora master credentials", () => {
  const pr = stageInfo("pr-12");
  // Master source refused outright.
  assert.throws(
    () => dbCredentials(pr, { kind: "master", username: "postgres", secretArn: MASTER_SECRET_ARN }),
    /master/,
  );
  // A pr-login source that points at any secret other than a2h/pr-12/db is refused.
  assert.throws(() => dbCredentials(pr, { kind: "pr-login", secretArn: MASTER_SECRET_ARN }), /a2h\/pr-12\/db/);
  const pr13 = PR12_SECRET_ARN.replace("pr-12", "pr-13");
  assert.throws(() => dbCredentials(pr, { kind: "pr-login", secretArn: pr13 }), /a2h\/pr-12\/db/);
  const creds = dbCredentials(pr, { kind: "pr-login", secretArn: PR12_SECRET_ARN });
  assert.ok(!JSON.stringify(creds).includes("DatabaseProxySecret"));
});

test("dev and prod keep the master user (M0), password still only through ssm", () => {
  for (const s of ["dev", "prod"]) {
    const creds = dbCredentials(stageInfo(s), {
      kind: "master",
      username: "postgres",
      secretArn: MASTER_SECRET_ARN,
    });
    assert.deepEqual(creds, {
      environment: { DB_USER: "postgres" },
      ssm: { DB_PASSWORD: `${MASTER_SECRET_ARN}:password::` },
    });
    assert.ok(!("DB_PASSWORD" in creds.environment));
    assert.throws(() => dbCredentials(stageInfo(s), { kind: "pr-login", secretArn: PR12_SECRET_ARN }), /pr/);
  }
});

test("dev and prod link the uploads bucket", () => {
  assert.deepEqual(storageAccess(stageInfo("dev")), { mode: "link" });
  assert.deepEqual(storageAccess(stageInfo("prod")), { mode: "link" });
});

test("pr-12 gets object access on uploads/pr-12/* and tmp/pr-12/* only, plus UPLOADS_BUCKET", () => {
  const access = storageAccess(stageInfo("pr-12"), "a2h-dev-uploadsbucket-x7k2");
  assert.deepEqual(access, {
    mode: "scoped",
    permissions: [
      {
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [
          "arn:aws:s3:::a2h-dev-uploadsbucket-x7k2/uploads/pr-12/*",
          "arn:aws:s3:::a2h-dev-uploadsbucket-x7k2/tmp/pr-12/*",
        ],
      },
    ],
    environment: { UPLOADS_BUCKET: "a2h-dev-uploadsbucket-x7k2" },
  });
  // No bucket-wide grant, no list, no wildcard action.
  const flat = JSON.stringify(access);
  assert.ok(!flat.includes("x7k2/*\""));
  assert.ok(!flat.includes("s3:*"));
  assert.ok(!flat.includes("ListBucket"));
});

test("pr storage needs a valid bucket name", () => {
  const pr = stageInfo("pr-12");
  for (const bad of [undefined, "", "Upper", "a2h/../x", "a2h-dev-uploads/*"]) {
    assert.throws(() => storageAccess(pr, bad), /bucket/, String(bad));
  }
});
