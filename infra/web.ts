// apps/web on CloudFront + Lambda through OpenNext (ADR 0001, decision 1).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { domain, hostnames, OPEN_NEXT_VERSION, type StageInfo } from "./config.ts";
import { storageArgs, type StorageGrant } from "./storage.ts";
import { secretArnFromValueFrom, webDatabasePermissions, webPlainEnvironment } from "./web-env.ts";

/**
 * How the web Lambda reaches the stage's database through the Data API
 * (m1-hosted-connector design D2): the cluster ARN and the ECS `valueFrom` of
 * the stage's database secret (dev: the master secret; pr-<n>: a2h/pr-<n>/db),
 * whose ARN the Data API reads. Absent only for a preview being removed.
 */
export interface WebDatabase {
  clusterArn: $util.Input<string>;
  secretValueFrom: $util.Input<string> | undefined;
}

export const WEB_NOT_DEPLOYED = "not deployed (apps/web has no Next.js app yet)";

/**
 * The owner deploys `dev` once before any Next.js app exists (step 4), so that
 * pr-* previews in step 5 find the shared resources. Until apps/web has a
 * next.config, the Web component is skipped. Step 5 removes nothing here: it
 * adds the app and this component starts deploying.
 */
export function hasNextApp(): boolean {
  const dir = join($cli.paths.root, "apps", "web");
  return ["next.config.ts", "next.config.mjs", "next.config.js"].some((f) =>
    existsSync(join(dir, f)),
  );
}

export function createWeb(
  stage: StageInfo,
  deps: {
    storage: StorageGrant;
    mcpUrl: $util.Input<string>;
    database: WebDatabase;
    /** The `email-sender` shared value (a domain, an address or "none"). */
    emailSender: $util.Input<string>;
  },
): sst.aws.Nextjs | undefined {
  if (!hasNextApp()) return undefined;
  const store = storageArgs(deps.storage);
  // Better Auth's secret (cookie signatures, hashes, the encryption of its
  // signing keys): 32 random bytes per stage, kept secret in state like the
  // stage's approval key (stage-secrets-resources.ts).
  const authSecret = new random.RandomBytes("AuthSecret", { length: 32 });
  const accountId = aws.getCallerIdentityOutput().accountId;
  const secretArn = deps.database.secretValueFrom
    ? $util.output(deps.database.secretValueFrom).apply(secretArnFromValueFrom)
    : undefined;
  const dbPermissions = secretArn
    ? $util
        .all([deps.database.clusterArn, secretArn, accountId])
        .apply(([clusterArn, arn, account]) => webDatabasePermissions(stage, { clusterArn, secretArn: arn, accountId: account }))
    : undefined;
  const plain = $util.output(deps.emailSender).apply((emailSender) =>
    webPlainEnvironment(stage, { domain, emailSender }),
  );
  return new sst.aws.Nextjs("Web", {
    path: "apps/web",
    // SST's default OpenNext (3.9.14) refuses Next 15.5.x; see config.ts.
    openNextVersion: OPEN_NEXT_VERSION,
    // eu-west-3 only (no `regions`): SSR and data access stay in the EU.
    server: {
      runtime: "nodejs22.x",
      architecture: "arm64",
      memory: "1024 MB",
      timeout: "20 seconds",
    },
    warm: stage.warm,
    ...(domain ? { domain: hostnames(stage, domain).web } : {}),
    // Database not linked: the Lambda is outside the VPC (Aurora is private)
    // and SST's link would place the password in the function's
    // environment. It uses the Data API instead (m1-hosted-connector D2):
    // IAM on the cluster ARN and the stage's database secret, no password.
    // Storage: dev/prod link the bucket; pr-* get object access under their
    // own prefix only (server function role; contract amendment 1); the mail
    // sink writes under tmp/<prefix>mail/ (D6), inside that grant.
    link: store.link,
    permissions: dbPermissions
      ? dbPermissions.apply((p) => [...store.permissions, ...p])
      : store.permissions,
    environment: $util
      .all([plain, deps.mcpUrl, deps.database.clusterArn, secretArn ?? "", authSecret.base64, $util.output(store.environment)])
      .apply(([env, mcpUrl, clusterArn, dbSecretArn, secret, storage]) => ({
        ...env,
        ...storage,
        STAGE: stage.name,
        STORAGE_PREFIX: stage.storagePrefix,
        MCP_URL: mcpUrl,
        DB_CLUSTER_ARN: clusterArn,
        DB_SECRET_ARN: dbSecretArn,
        BETTER_AUTH_SECRET: secret,
      })),
  });
}
