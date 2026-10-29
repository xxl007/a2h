// SST/Pulumi resources of the per-stage secrets `a2h/<stage>/signing` and
// `a2h/<stage>/approval` (m1-protocol-connector design D4 amendment): created
// by the stage itself on dev, prod and every preview; nothing to do by hand.
// Key material comes from the Pulumi `tls` (Ed25519) and `random` (32 bytes)
// providers, whose outputs are secret in Pulumi state; the secret values are
// wrapped in $util.secret as well and are never exported as stack outputs.
// Names, formats and rotation: stage-secrets.ts and docs/runbooks/aws-bootstrap.md §14.
import type { StageInfo } from "./config.ts";
import {
  approvalSecretValue,
  keyGeneration,
  recoveryWindowInDays,
  secretResourceName,
  signingSecretValue,
  stageSecretName,
  type StageSecretKind,
} from "./stage-secrets.ts";

export interface StageSecretOutputs {
  arn: $util.Output<string>;
  /** The version this deploy wrote; ECS `valueFrom` pins it (stage-secrets.ts secretsEnvironment). */
  versionId: $util.Output<string>;
}
export type StageSecrets = Record<StageSecretKind, StageSecretOutputs>;

const DESCRIPTIONS: Record<StageSecretKind, string> = {
  signing: "A2H platform Ed25519 answer-signing key (key_id, PKCS#8, raw public key). Created by SST.",
  approval: "A2H HMAC key for MCP approval request state (32 bytes, base64). Created by SST.",
};

function storeSecret(stage: StageInfo, kind: StageSecretKind, value: $util.Output<string>): StageSecretOutputs {
  const base = kind === "signing" ? "SigningSecret" : "ApprovalSecret";
  const secret = new aws.secretsmanager.Secret(base, {
    name: stageSecretName(stage, kind),
    description: DESCRIPTIONS[kind],
    recoveryWindowInDays: recoveryWindowInDays(stage),
  });
  // Without versionStages, Secrets Manager moves AWSCURRENT to each new version.
  const version = new aws.secretsmanager.SecretVersion(`${base}Value`, {
    secretId: secret.id,
    secretString: $util.secret(value),
  });
  return { arn: secret.arn, versionId: version.versionId };
}

export function createStageSecrets(stage: StageInfo): StageSecrets {
  const signingKey = new tls.PrivateKey(secretResourceName("signing", keyGeneration(stage, "signing")), {
    algorithm: "ED25519",
  });
  const approvalKey = new random.RandomBytes(secretResourceName("approval", keyGeneration(stage, "approval")), {
    length: 32,
  });
  const signingValue = $util
    .all([signingKey.privateKeyPemPkcs8, signingKey.publicKeyPem])
    .apply(([privatePem, publicPem]) => signingSecretValue(stage, privatePem, publicPem));
  const approvalValue = approvalKey.base64.apply(approvalSecretValue);
  return {
    signing: storeSecret(stage, "signing", signingValue),
    approval: storeSecret(stage, "approval", approvalValue),
  };
}
