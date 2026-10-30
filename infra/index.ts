// Entry point imported by the root sst.config.ts inside run(), after the
// permissions-boundary $transform is registered.
import { storageAccess } from "./access.ts";
import { createAllowlist } from "./allowlist.ts";
import { domain, EMAIL_SENDER_NONE, stageInfo, type StageInfo } from "./config.ts";
import { albBaseUrl, createAlb, createCluster, getAlb, getCluster } from "./cluster.ts";
import { createDatabase, masterAccess, previewAccess, type DbAccess } from "./database.ts";
import { createEmail, getEmail } from "./email.ts";
import { createMcp } from "./mcp.ts";
import { webBaseUrl } from "./service-env.ts";
import { publishShared, readShared } from "./shared.ts";
import { createStageSecrets } from "./stage-secrets-resources.ts";
import { createUploads, type StorageGrant } from "./storage.ts";
import { createVpc, getVpc } from "./vpc.ts";
import { attachWebAcl, createEdgeAcls } from "./waf.ts";
import { createWeb, WEB_NOT_DEPLOYED } from "./web.ts";
import { createWorker } from "./worker.ts";

interface Base {
  cluster: sst.aws.Cluster;
  alb: sst.aws.Alb;
  db: DbAccess;
  storage: StorageGrant;
  email: sst.aws.Email | undefined;
  /**
   * CLOUDFRONT-scope web ACL for the web distribution (design D5): the
   * stage's own on dev/prod, dev's on pr-* (undefined until dev has published it).
   */
  webAclCloudfrontArn: $util.Input<string> | undefined;
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
  // Edge rate limit (m1-hosted-connector D5): REGIONAL on this ALB, CLOUDFRONT for the web.
  const edge = createEdgeAcls(stage, alb);
  // The sign-in allow-list (D7): dev's is shared with previews.
  createAllowlist(stage);
  return {
    cluster,
    alb,
    db: masterAccess(stage, database),
    storage: { mode: "link", bucket: uploads },
    email,
    webAclCloudfrontArn: edge.cloudfrontAclArn,
    shared: {
      vpcId: vpc.id,
      clusterId: cluster.id,
      albArn: alb.arn,
      auroraClusterId: database.id,
      auroraClusterArn: database.clusterArn,
      auroraSecretArn: database.secretArn,
      uploadsBucket: uploads.name,
      emailSender: email ? email.sender : EMAIL_SENDER_NONE,
      webAclCloudfrontArn: edge.cloudfrontAclArn,
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
  return {
    cluster: getCluster(ids.clusterId, vpc),
    alb: getAlb(ids.albArn),
    db: await previewAccess(stage, ids.auroraClusterId, command),
    storage,
    email: getEmail(ids.emailSender),
    // dev's ALB already carries dev's REGIONAL web ACL; the web distribution gets dev's CLOUDFRONT one.
    webAclCloudfrontArn: ids.webAclCloudfrontArn,
  };
}

/**
 * `command` is the SST CLI command running the program (`$cli.command`:
 * "deploy", "remove", "diff", "refresh", …). Only previewAccess reads it.
 */
export async function deploy(stageName: string, command: string) {
  const stage = stageInfo(stageName);
  const { cluster, alb, db, storage, email, webAclCloudfrontArn, shared } = stage.ownsSharedResources
    ? ownResources(stage)
    : await borrowedResources(stage, command);

  // a2h/<stage>/signing and a2h/<stage>/approval: every stage creates its own.
  const secrets = createStageSecrets(stage);
  const deps = { stage, cluster, db, storage, email, secrets };

  const albUrl = albBaseUrl(stage, alb);
  const mcpUrl = $interpolate`${albUrl}${stage.mcpBasePath}`;
  // Edge rate limit on the web distribution (D5), registered before createWeb:
  // the transform must exist when the distribution is constructed.
  if (webAclCloudfrontArn) attachWebAcl(webAclCloudfrontArn);
  // The web app hosts the stage's authorization server (m1-hosted-connector
  // D1), so it is created first: the mcp service trusts its issuer.
  const web = createWeb(stage, { storage, mcpUrl });
  // Without apps/web there is no authorization server: the issuer then names
  // an address that serves no keys, and the gate answers 401 (fails closed).
  const webUrl = web ? web.url.apply((u) => webBaseUrl(stage, domain, u)) : $output(webBaseUrl(stage, domain, "https://web-not-deployed.invalid"));
  createMcp(deps, alb, { albBaseUrl: albUrl, webBaseUrl: webUrl });
  createWorker(deps);

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
