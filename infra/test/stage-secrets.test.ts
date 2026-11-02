// Per-stage signing and approval secrets (m1-protocol-connector design D1,
// D4 and its amendment; task 6.1). Pure mapping only; the SST resources are
// in stage-secrets-resources.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { importPrivateKey, importPublicKey } from "../../packages/protocol/src/index.ts";
import { executionRolePolicy, secretValueFrom } from "../access.ts";
import { STAGE_KEY_GENERATIONS, stageInfo } from "../config.ts";
import {
  approvalSecretValue,
  keyGeneration,
  recoveryWindowInDays,
  SECRET_ENV,
  SECRET_SERVICES,
  secretResourceName,
  secretsEnvironment,
  signingKeyId,
  signingSecretValue,
  stageSecretName,
  STAGE_SECRET_KINDS,
} from "../stage-secrets.ts";

const ACCOUNT = "123456789012";
const arn = (name: string) => `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:${name}-AbC123`;
const VERSION = "8d3c1e6a-4f2b-4c1d-9e7a-0b5f6c7d8e9f";

function ed25519Pems() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { x } = publicKey.export({ format: "jwk" });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    rawPublic: Uint8Array.from(Buffer.from(String(x), "base64url")),
  };
}

test("secret names: a2h/<stage>/signing and a2h/<stage>/approval on every stage", () => {
  assert.deepEqual([...STAGE_SECRET_KINDS], ["signing", "approval"]);
  for (const s of ["dev", "prod", "pr-12"]) {
    assert.equal(stageSecretName(stageInfo(s), "signing"), `a2h/${s}/signing`);
    assert.equal(stageSecretName(stageInfo(s), "approval"), `a2h/${s}/approval`);
  }
  // Never the preview database secret's name, which pr-schema.sh owns.
  assert.notEqual(stageSecretName(stageInfo("pr-12"), "signing"), "a2h/pr-12/db");
});

test("who receives what: mcp only the approval key, the worker only the signing key", () => {
  assert.deepEqual(SECRET_SERVICES, { signing: ["worker"], approval: ["mcp"] });
  assert.deepEqual(SECRET_ENV, {
    signing: { key_id: "SIGNING_KEY_ID", private_key_pkcs8: "SIGNING_PRIVATE_KEY", public_key: "SIGNING_PUBLIC_KEY" },
    approval: { key: "APPROVAL_KEY" },
  });
});

test("signing secret: PKCS#8 and raw public key in base64, importable by packages/protocol, signature verifies", async () => {
  const { privatePem, publicPem, rawPublic } = ed25519Pems();
  const value = JSON.parse(signingSecretValue(stageInfo("pr-12"), privatePem, publicPem)) as Record<string, string>;
  assert.deepEqual(Object.keys(value).sort(), ["key_id", "private_key_pkcs8", "public_key"]);
  assert.equal(value.key_id, signingKeyId(stageInfo("pr-12"), rawPublic));
  const pkcs8 = Uint8Array.from(Buffer.from(value.private_key_pkcs8, "base64"));
  const raw = Uint8Array.from(Buffer.from(value.public_key, "base64"));
  assert.equal(pkcs8.length, 48);
  assert.deepEqual(raw, rawPublic);
  const priv = await importPrivateKey(pkcs8);
  const pub = await importPublicKey(raw);
  const data = new TextEncoder().encode("canonical payload");
  const sig = await globalThis.crypto.subtle.sign({ name: "Ed25519" }, priv, data);
  assert.ok(await globalThis.crypto.subtle.verify({ name: "Ed25519" }, pub, sig, data));
});

test("signing secret refuses anything but an Ed25519 PKCS#8 / SPKI PEM pair", () => {
  const { privatePem, publicPem } = ed25519Pems();
  const other = ed25519Pems();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pr = stageInfo("pr-12");
  assert.throws(() => signingSecretValue(pr, publicPem, publicPem), /PRIVATE KEY/);
  assert.throws(() => signingSecretValue(pr, privatePem, privatePem), /PUBLIC KEY/);
  assert.throws(
    () => signingSecretValue(pr, rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicPem),
    /Ed25519/,
  );
  assert.throws(
    () => signingSecretValue(pr, privatePem, rsa.publicKey.export({ type: "spki", format: "pem" }).toString()),
    /Ed25519/,
  );
  // A private key and a public key that do not belong together are refused:
  // the key id names the public key the answers verify with.
  assert.throws(() => signingSecretValue(pr, privatePem, other.publicPem), /pair/);
});

test("key id: a2h-<stage>-<16 hex of SHA-256(public key)>, an opaque id of at most 64 characters", () => {
  const { rawPublic } = ed25519Pems();
  for (const s of ["dev", "prod", "pr-19899"]) {
    const id = signingKeyId(stageInfo(s), rawPublic);
    assert.match(id, new RegExp(`^a2h-${s}-[0-9a-f]{16}$`));
    assert.ok(id.length <= 64);
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
  }
  const other = ed25519Pems().rawPublic;
  assert.notEqual(signingKeyId(stageInfo("dev"), rawPublic), signingKeyId(stageInfo("dev"), other));
  assert.throws(() => signingKeyId(stageInfo("dev"), rawPublic.slice(1)), /32 bytes/);
});

test("approval secret: exactly 32 random bytes in base64 (createRequestStateCodec needs >= 32)", () => {
  const b64 = randomBytes(32).toString("base64");
  assert.deepEqual(JSON.parse(approvalSecretValue(b64)), { key: b64 });
  for (const bad of [randomBytes(31).toString("base64"), randomBytes(33).toString("base64"), "", "not base64!"]) {
    assert.throws(() => approvalSecretValue(bad), /32 bytes/, bad);
  }
});

test("rotation generations: previews always 1; dev and prod from STAGE_KEY_GENERATIONS", () => {
  for (const kind of STAGE_SECRET_KINDS) {
    assert.equal(keyGeneration(stageInfo("pr-12"), kind), 1);
    for (const s of ["dev", "prod"] as const) {
      assert.equal(keyGeneration(stageInfo(s), kind), STAGE_KEY_GENERATIONS[s][kind]);
      assert.ok(Number.isSafeInteger(STAGE_KEY_GENERATIONS[s][kind]) && STAGE_KEY_GENERATIONS[s][kind] >= 1);
    }
  }
  // Generation 1 keeps the plain logical name; a bump gives a new resource.
  assert.equal(secretResourceName("signing", 1), "SigningKey");
  assert.equal(secretResourceName("signing", 2), "SigningKeyG2");
  assert.equal(secretResourceName("approval", 1), "ApprovalKey");
  assert.equal(secretResourceName("approval", 3), "ApprovalKeyG3");
  assert.throws(() => secretResourceName("signing", 0), /generation/);
});

test("previews delete their secrets at once on remove; dev and prod keep the recovery window", () => {
  assert.equal(recoveryWindowInDays(stageInfo("pr-12")), 0);
  assert.equal(recoveryWindowInDays(stageInfo("dev")), 30);
  assert.equal(recoveryWindowInDays(stageInfo("prod")), 30);
});

test("ECS secrets per service, pinned to the deployed version so a rotation rolls the tasks", () => {
  const pr = stageInfo("pr-12");
  const refs = {
    signing: { arn: arn("a2h/pr-12/signing"), versionId: VERSION },
    approval: { arn: arn("a2h/pr-12/approval"), versionId: VERSION },
  };
  assert.deepEqual(secretsEnvironment(pr, "mcp", refs), {
    APPROVAL_KEY: `${refs.approval.arn}:key::${VERSION}`,
  });
  assert.deepEqual(secretsEnvironment(pr, "worker", refs), {
    SIGNING_KEY_ID: `${refs.signing.arn}:key_id::${VERSION}`,
    SIGNING_PRIVATE_KEY: `${refs.signing.arn}:private_key_pkcs8::${VERSION}`,
    SIGNING_PUBLIC_KEY: `${refs.signing.arn}:public_key::${VERSION}`,
  });
  // Another stage's secret is refused.
  assert.throws(
    () => secretsEnvironment(pr, "mcp", { ...refs, approval: { arn: arn("a2h/pr-120/approval"), versionId: VERSION } }),
    /a2h\/pr-12\/approval/,
  );
});

test("valueFrom with a version id: <arn>:<key>::<versionId>; malformed ids refused", () => {
  const a = arn("a2h/dev/signing");
  assert.equal(secretValueFrom(a, "key_id"), `${a}:key_id::`);
  assert.equal(secretValueFrom(a, "key_id", VERSION), `${a}:key_id::${VERSION}`);
  for (const bad of ["", "AWSCURRENT:x", "a b", "x".repeat(65)]) {
    assert.throws(() => secretValueFrom(a, "key_id", bad), /version/, bad);
  }
});

test("execution role reads the stage's own secrets, by exact ARN, and nothing else", () => {
  const master = arn("a2h-dev-DatabaseProxySecret-3f1c9a7");
  const stageArns = [arn("a2h/dev/signing"), arn("a2h/dev/approval")];
  const policy = executionRolePolicy(stageInfo("dev"), { kind: "master", secretArn: master }, stageArns);
  assert.deepEqual(policy.Statement, [
    { Sid: "ReadDbPassword", Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: [master] },
    { Sid: "ReadStageSecrets", Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: stageArns },
  ]);
  // Without stage secrets the policy is unchanged (M0 shape).
  assert.equal(executionRolePolicy(stageInfo("dev"), { kind: "master", secretArn: master }).Statement.length, 1);
  // Another stage's secret, a wildcard, or a non-ARN is refused.
  for (const bad of [arn("a2h/prod/signing"), arn("a2h/dev/db"), "arn:aws:secretsmanager:eu-west-3:123456789012:secret:a2h/dev/*", "a2h/dev/signing"]) {
    assert.throws(
      () => executionRolePolicy(stageInfo("dev"), { kind: "master", secretArn: master }, [bad]),
      /stage secret/,
      bad,
    );
  }
  const pr = executionRolePolicy(stageInfo("pr-12"), { kind: "pr-login", accountId: ACCOUNT }, [arn("a2h/pr-12/signing")]);
  assert.deepEqual(pr.Statement[1]?.Resource, [arn("a2h/pr-12/signing")]);
});
