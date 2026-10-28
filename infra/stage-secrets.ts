// The per-stage secrets `a2h/<stage>/signing` and `a2h/<stage>/approval`
// (m1-protocol-connector design D1, D4 and its 2026-10-28 amendment): names,
// value formats, key ids, which service receives which key, and the ECS
// `secrets` entries. Pure: no SST globals, no AWS call; unit-tested in
// infra/test/stage-secrets.test.ts. The resources are created in
// stage-secrets-resources.ts; rotation is docs/runbooks/aws-bootstrap.md §14.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { secretValueFrom } from "./access.ts";
import { STAGE_KEY_GENERATIONS, type StageInfo } from "./config.ts";

export const STAGE_SECRET_KINDS = ["signing", "approval"] as const;
export type StageSecretKind = (typeof STAGE_SECRET_KINDS)[number];
export type Service = "mcp" | "worker";

/**
 * JSON key in the secret value -> environment variable in the container.
 * - signing: the Ed25519 key the platform signs answers with. `private_key_pkcs8`
 *   is base64 of the PKCS#8 DER (what `importPrivateKey` of packages/protocol
 *   takes); `public_key` is base64 of the raw 32-byte key (`importPublicKey`),
 *   recorded in `signing_keys` under `key_id` so answers verify after rotation.
 * - approval: the HMAC key of `createRequestStateCodec` (design D1), base64 of
 *   32 random bytes; the app decodes it to a Uint8Array.
 */
export const SECRET_ENV = {
  signing: { key_id: "SIGNING_KEY_ID", private_key_pkcs8: "SIGNING_PRIVATE_KEY", public_key: "SIGNING_PUBLIC_KEY" },
  approval: { key: "APPROVAL_KEY" },
} as const satisfies Record<StageSecretKind, Record<string, string>>;

/**
 * The mcp service mints and verifies approval state (D1); it verifies answers
 * with public keys from `signing_keys` and never signs, so it never receives
 * the signing key. The worker signs simulated answers (D8) and never sees the
 * approval key.
 */
export const SECRET_SERVICES: Record<StageSecretKind, readonly Service[]> = {
  signing: ["worker"],
  approval: ["mcp"],
};

export function stageSecretName(stage: StageInfo, kind: StageSecretKind): string {
  return `a2h/${stage.name}/${kind}`;
}

/**
 * Rotation generation. A preview is short-lived and always at 1 (fresh keys on
 * every create). dev and prod read STAGE_KEY_GENERATIONS in config.ts: bumping
 * a number and deploying creates a new key and a new secret version (§14).
 */
export function keyGeneration(stage: StageInfo, kind: StageSecretKind): number {
  if (stage.kind === "pr") return 1;
  return STAGE_KEY_GENERATIONS[stage.kind][kind];
}

/**
 * Logical name of the key-material resource (tls.PrivateKey, random.RandomBytes)
 * for a generation. Generation 1 keeps the plain name; a new name is a new
 * resource, so a bump replaces the key without touching the secret itself.
 */
export function secretResourceName(kind: StageSecretKind, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`Key generation must be a positive integer, got ${generation}.`);
  }
  const base = kind === "signing" ? "SigningKey" : "ApprovalKey";
  return generation === 1 ? base : `${base}G${generation}`;
}

/**
 * Days Secrets Manager keeps a deleted secret. Previews: 0 (immediate), so a
 * re-deploy of the same PR after `sst remove` can create the name again.
 * dev and prod are retained by SST (`removal: "retain"`) anyway; 30 is AWS's default.
 */
export function recoveryWindowInDays(stage: StageInfo): number {
  return stage.kind === "pr" ? 0 : 30;
}

// DER prefixes of an Ed25519 key (RFC 8410): PKCS#8 v1 private key (48 bytes
// in all) and SubjectPublicKeyInfo (44 bytes in all, the last 32 the raw key).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function pemDer(pem: string, label: string): Buffer {
  const m = new RegExp(`^-----BEGIN ${label}-----\\r?\\n([A-Za-z0-9+/=\\r\\n]+)-----END ${label}-----\\r?\\n?$`).exec(pem.trim() + "\n");
  if (!m?.[1]) throw new Error(`Expected a PEM block "${label}".`);
  return Buffer.from(m[1].replace(/\s+/g, ""), "base64");
}

function withPrefix(der: Buffer, prefix: Buffer, total: number, what: string): Buffer {
  if (der.length !== total || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new Error(`${what} is not an Ed25519 key.`);
  }
  return der;
}

/** Key id: `a2h-<stage>-` and the first 16 hex characters of SHA-256 over the raw public key. */
export function signingKeyId(stage: StageInfo, rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) throw new Error("An Ed25519 public key is 32 bytes.");
  const digest = createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
  return `a2h-${stage.name}-${digest}`;
}

/**
 * Value of `a2h/<stage>/signing` from the PEMs of the tls provider
 * (`privateKeyPemPkcs8`, `publicKeyPem`). Refuses a non-Ed25519 key and a
 * public key that is not the private key's own.
 */
export function signingSecretValue(stage: StageInfo, privateKeyPemPkcs8: string, publicKeyPem: string): string {
  const pkcs8 = withPrefix(pemDer(privateKeyPemPkcs8, "PRIVATE KEY"), PKCS8_ED25519_PREFIX, 48, "The private key");
  const spki = withPrefix(pemDer(publicKeyPem, "PUBLIC KEY"), SPKI_ED25519_PREFIX, 44, "The public key");
  const derived = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({
    format: "der",
    type: "spki",
  });
  if (!derived.equals(spki)) throw new Error("The public key is not the pair of the private key.");
  const raw = spki.subarray(SPKI_ED25519_PREFIX.length);
  return JSON.stringify({
    key_id: signingKeyId(stage, raw),
    private_key_pkcs8: pkcs8.toString("base64"),
    public_key: raw.toString("base64"),
  });
}

/** Value of `a2h/<stage>/approval` from `random.RandomBytes({ length: 32 }).base64`. */
export function approvalSecretValue(base64: string): string {
  const ok = /^[A-Za-z0-9+/]+={0,2}$/.test(base64) && base64.length % 4 === 0;
  if (!ok || Buffer.from(base64, "base64").length !== 32) {
    throw new Error("The approval key must be 32 bytes in base64.");
  }
  return JSON.stringify({ key: base64 });
}

/** A created secret: its ARN and the version this deploy wrote. */
export interface SecretRef {
  arn: string;
  versionId: string;
}

/**
 * ECS `secrets` (SST Service `ssm`) for one service: env name -> valueFrom
 * `<arn>:<jsonKey>::<versionId>`. Pinned to the version the deploy wrote, so
 * a rotation changes the task definition and ECS replaces the running tasks;
 * a version written by hand outside the deploy is never picked up silently.
 */
export function secretsEnvironment(
  stage: StageInfo,
  service: Service,
  refs: Record<StageSecretKind, SecretRef>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of STAGE_SECRET_KINDS) {
    if (!SECRET_SERVICES[kind].includes(service)) continue;
    const { arn, versionId } = refs[kind];
    const name = stageSecretName(stage, kind);
    if (!arn.includes(`:secret:${name}-`)) {
      throw new Error(`Stage "${stage.name}" must read ${name}, got "${arn}".`);
    }
    for (const [jsonKey, envName] of Object.entries(SECRET_ENV[kind])) {
      out[envName] = secretValueFrom(arn, jsonKey, versionId);
    }
  }
  return out;
}

/** Kinds of secret a service receives (for its execution-role grant). */
export function secretKindsFor(service: Service): StageSecretKind[] {
  return STAGE_SECRET_KINDS.filter((kind) => SECRET_SERVICES[kind].includes(service));
}
