// Entry point imported by the root sst.config.ts inside run(), after the
// permissions-boundary $transform is registered.
import { storageAccess } from "./access.ts";
import { EMAIL_SENDER_NONE, stageInfo, type StageInfo } from "./config.ts";
import { albBaseUrl, createAlb, createCluster, getAlb, getCluster } from "./cluster.ts";
import { createDatabase, masterAccess, previewAccess, type DbAccess } from "./database.ts";
import { createEmail, getEmail } from "./email.ts";
import { createMcp } from "./mcp.ts";
import { publishShared, readShared } from "./shared.ts";
import { createStageSecrets } from "./stage-secrets-resources.ts";
import { createUploads, type StorageGrant } from "./storage.ts";
import { createVpc, getVpc } from "./vpc.ts";
import { createWeb, WEB_NOT_DEPLOYED, type WebDatabase } from "./web.ts";
import { createWorker } from "./worker.ts";

interface Base {
  cluster: sst.aws.Cluster;
  alb: sst.aws.Alb;
  db: DbAccess;
  storage: StorageGrant;
  email: sst.aws.Email | undefined;
  /** The web app's Data API access (m1-hosted-connector D2). */
  webDatabase: WebDatabase;
  /** The `email-sender` value: the SES identity, or EMAIL_SENDER_NONE. */
  emailSender: $util.Input<string>;
  /** dev only: identifiers published under /a2h/shared/ and output. */
  shared?: Parameters<typeof publishShared>[0];
}

/** dev and prod: create the environment's own resources, master DB user (M0). */
function ownResources(stage: StageInfo): Base {
  const vpc = createVpc();
  const cluster = createCluster(vpc);
  const alb = createAlb(stage, vpc);
  const database = createDatabase(stage, vpc);
  const uploads = createUploads();
  const email = createEmail();
  const db = masterAccess(stage, database);
  return {
    cluster,
    alb,
    db,
    storage: { mode: "link", bucket: uploads },
    email,
    webDatabase: { clusterArn: database.clusterArn, secretValueFrom: "DB_PASSWORD" in db.ssm ? db.ssm.DB_PASSWORD : undefined },
    emailSender: email ? email.sender : EMAIL_SENDER_NONE,
    shared: {
      vpcId: vpc.id,
      clusterId: cluster.id,
      albArn: alb.arn,
      auroraClusterId: database.id,
      auroraClusterArn: database.clusterArn,
      auroraSecretArn: database.secretArn,
      uploadsBucket: uploads.name,
      emailSender: email ? email.sender : EMAIL_SENDER_NONE,
    },
  };
}

/**
 * pr-<n>: borrow dev's resources. Database login `pr_<n>` from secret
 * `a2h/pr-<n>/db`; bucket not linked, object access under the PR prefix only.
 */
async function borrowedResources(stage: StageInfo, command: string): Promise<Base> {
  const ids = await readShared();
  const vpc = getVpc(ids.vpcId);
  const storage = storageAccess(stage, ids.uploadsBucket);
  if (storage.mode !== "scoped") throw new Error(`Stage ${stage.name} must not link the bucket.`);
  const db = await previewAccess(stage, ids.auroraClusterId, command);
  return {
    cluster: getCluster(ids.clusterId, vpc),
    alb: getAlb(ids.albArn),
    db,
    storage,
    email: getEmail(ids.emailSender),
    webDatabase: {
      clusterArn: aws.rds.getClusterOutput({ clusterIdentifier: ids.auroraClusterId }).arn,
      secretValueFrom: "DB_PASSWORD" in db.ssm ? db.ssm.DB_PASSWORD : undefined,
    },
    emailSender: ids.emailSender,
  };
}

/**
 * `command` is the SST CLI command running the program (`$cli.command`:
 * "deploy", "remove", "diff", "refresh", …). Only previewAccess reads it.
 */
export async function deploy(stageName: string, command: string) {
  const stage = stageInfo(stageName);
  const { cluster, alb, db, storage, email, webDatabase, emailSender, shared } = stage.ownsSharedResources
    ? ownResources(stage)
    : await borrowedResources(stage, command);

  // a2h/<stage>/signing and a2h/<stage>/approval: every stage creates its own.
  const secrets = createStageSecrets(stage);
  const deps = { stage, cluster, db, storage, email, secrets };
  createMcp(deps, alb);
  createWorker(deps);

  const albUrl = albBaseUrl(stage, alb);
  const mcpUrl = $interpolate`${albUrl}${stage.mcpBasePath}`;
  const web = createWeb(stage, { storage, mcpUrl, database: webDatabase, emailSender });

  // Only dev publishes: prod's resources are its own and never shared.
  if (stage.kind === "dev" && shared) publishShared(shared);

  return {
    stage: stage.name,
    web: web ? web.url : WEB_NOT_DEPLOYED,
    mcp: mcpUrl,
    albUrl,
    ...(stage.kind === "dev" && shared ? { shared } : {}),
  };
}
