// Entry point imported by the root sst.config.ts inside run().
import { stageInfo } from "./config.ts";
import { albBaseUrl, createAlb, createCluster, getAlb, getCluster } from "./cluster.ts";
import { createDatabase, getDatabase } from "./database.ts";
import { createEmail, getEmail } from "./email.ts";
import { createMcp } from "./mcp.ts";
import { publishShared, readShared } from "./shared.ts";
import { createUploads, getUploads } from "./storage.ts";
import { createVpc, getVpc } from "./vpc.ts";
import { createWeb, WEB_NOT_DEPLOYED } from "./web.ts";
import { createWorker } from "./worker.ts";
import { EMAIL_SENDER_NONE } from "./config.ts";

export async function deploy(stageName: string) {
  const stage = stageInfo(stageName);

  let base;
  if (stage.ownsSharedResources) {
    const vpc = createVpc();
    base = {
      vpc,
      cluster: createCluster(vpc),
      alb: createAlb(stage, vpc),
      database: createDatabase(stage, vpc),
      uploads: createUploads(),
      email: createEmail(),
    };
  } else {
    const ids = await readShared();
    const vpc = getVpc(ids.vpcId);
    base = {
      vpc,
      cluster: getCluster(ids.clusterId, vpc),
      alb: getAlb(ids.albArn),
      database: getDatabase(ids.auroraClusterId),
      uploads: getUploads(ids.uploadsBucket),
      email: getEmail(ids.emailSender),
    };
  }
  const { vpc, cluster, alb, database, uploads, email } = base;

  const deps = { stage, cluster, database, uploads, email };
  createMcp(deps, alb);
  createWorker(deps);

  const albUrl = albBaseUrl(stage, alb);
  const mcpUrl = $interpolate`${albUrl}${stage.mcpBasePath}`;
  const web = createWeb(stage, { uploads, mcpUrl });

  const shared = {
    vpcId: vpc.id,
    clusterId: cluster.id,
    albArn: alb.arn,
    auroraClusterId: database.id,
    auroraClusterArn: database.clusterArn,
    auroraSecretArn: database.secretArn,
    uploadsBucket: uploads.name,
    emailSender: email ? email.sender : EMAIL_SENDER_NONE,
  };
  // Only dev publishes: prod's resources are its own and never shared.
  if (stage.kind === "dev") publishShared(shared);

  return {
    stage: stage.name,
    web: web ? web.url : WEB_NOT_DEPLOYED,
    mcp: mcpUrl,
    albUrl,
    ...(stage.kind === "dev" ? { shared } : {}),
  };
}
