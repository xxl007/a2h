// Contract amendment 1 (tasks.md): per-PR database login and scoped storage
// on previews. Pure mapping only; the SST wiring is in database.ts and mcp.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dbCredentials,
  executionRolePolicy,
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

test("a preview's grant never covers a dev or prod object, even one keyed pr-<n>/...", () => {
  const bucket = "a2h-dev-uploadsbucket-x7k2";
  const access = storageAccess(stageInfo("pr-12"), bucket);
  assert.equal(access.mode, "scoped");
  if (access.mode !== "scoped") return;
  const patterns = access.permissions.flatMap((p) => p.resources);
  // IAM object ARNs here only use a trailing "*".
  const covered = (key: string) =>
    patterns.some((p) => `arn:aws:s3:::${bucket}/${key}`.startsWith(p.slice(0, -1)));
  for (const owner of ["dev", "prod"]) {
    const prefix = stageInfo(owner).storagePrefix;
    for (const area of ["uploads", "tmp"]) {
      assert.ok(!covered(`${area}/${prefix}pr-12/voice.webm`), `${owner} ${area}`);
      assert.ok(!covered(`${area}/${prefix}x`), `${owner} ${area}`);
    }
  }
  assert.ok(covered("uploads/pr-12/voice.webm"));
  assert.ok(!covered("uploads/pr-120/voice.webm"));
});

test("pr-12 execution role reads only a2h/pr-12/db-*, nothing from SSM", () => {
  const policy = executionRolePolicy(stageInfo("pr-12"), { kind: "pr-login", accountId: ACCOUNT });
  assert.deepEqual(policy, {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadDbPassword",
        Effect: "Allow",
        Action: ["secretsmanager:GetSecretValue"],
        Resource: [`arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:a2h/pr-12/db-*`],
      },
    ],
  });
  // The looked-up secret matches the grant; pr-120's and the master's do not.
  const resource = policy.Statement[0]?.Resource[0] ?? "";
  const grants = (arn: string) => arn.startsWith(resource.slice(0, -1));
  assert.ok(grants(PR12_SECRET_ARN));
  assert.ok(!grants(PR12_SECRET_ARN.replace("pr-12", "pr-120")));
  assert.ok(!grants(MASTER_SECRET_ARN));
});

test("dev and prod execution roles read only the Aurora master secret", () => {
  for (const s of ["dev", "prod"]) {
    const policy = executionRolePolicy(stageInfo(s), { kind: "master", secretArn: MASTER_SECRET_ARN });
    assert.deepEqual(policy.Statement, [
      {
        Sid: "ReadDbPassword",
        Effect: "Allow",
        Action: ["secretsmanager:GetSecretValue"],
        Resource: [MASTER_SECRET_ARN],
      },
    ]);
  }
});

test("execution role policies: no wildcard resource, no SSM, no other action", () => {
  const policies = [
    executionRolePolicy(stageInfo("pr-12"), { kind: "pr-login", accountId: ACCOUNT }),
    executionRolePolicy(stageInfo("dev"), { kind: "master", secretArn: MASTER_SECRET_ARN }),
    executionRolePolicy(stageInfo("prod"), { kind: "master", secretArn: MASTER_SECRET_ARN }),
  ];
  for (const policy of policies) {
    for (const st of policy.Statement) {
      assert.deepEqual(st.Action, ["secretsmanager:GetSecretValue"]);
      for (const r of st.Resource) assert.notEqual(r, "*");
    }
    assert.ok(!JSON.stringify(policy).includes("ssm:"));
  }
});

test("execution role policy refuses mismatched sources and bad inputs", () => {
  const pr = stageInfo("pr-12");
  assert.throws(
    () => executionRolePolicy(pr, { kind: "master", secretArn: MASTER_SECRET_ARN }),
    /master/,
  );
  for (const bad of ["", "12345678901", "*", "123456789012:*"]) {
    assert.throws(() => executionRolePolicy(pr, { kind: "pr-login", accountId: bad }), /account/, bad);
  }
  for (const s of ["dev", "prod"]) {
    assert.throws(
      () => executionRolePolicy(stageInfo(s), { kind: "pr-login", accountId: ACCOUNT }),
      /pr/,
      s,
    );
    for (const bad of ["*", "a2h/pr-12/db", `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:*`]) {
      assert.throws(
        () => executionRolePolicy(stageInfo(s), { kind: "master", secretArn: bad }),
        /ARN/,
        bad,
      );
    }
  }
});
