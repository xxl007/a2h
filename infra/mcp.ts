// A2H MCP server on Fargate behind the environment's ALB.
// Routing: dev/prod `/mcp`, `/mcp/*`, `/healthz` (priorities 49000-49002);
// pr-<n> `/pr-<n>/*` (priority 100 + n). See config.ts stageInfo.
import { MCP_PORT, type StageInfo } from "./config.ts";
import { serviceListener } from "./cluster.ts";
import { databaseEnv, type Database } from "./database.ts";

export interface ServiceDeps {
  stage: StageInfo;
  cluster: sst.aws.Cluster;
  database: Database;
  uploads: sst.aws.Bucket;
  email: sst.aws.Email | undefined;
}

/** Environment, secrets and links shared by the MCP and worker containers. */
export function containerConfig({ stage, database, uploads, email }: ServiceDeps) {
  const db = databaseEnv(database, stage);
  return {
    environment: {
      PORT: String(MCP_PORT),
      STAGE: stage.name,
      MCP_BASE_PATH: stage.mcpBasePath,
      STORAGE_PREFIX: stage.storagePrefix,
      ...db.environment,
    },
    ssm: db.ssm,
    // `link` grants the task role least-privilege IAM on these resources.
    link: email ? [uploads, email] : [uploads],
  };
}

export function createMcp(deps: ServiceDeps, alb: sst.aws.Alb) {
  const { stage, cluster } = deps;
  const forward = `${MCP_PORT}/http` as const;
  return new sst.aws.Service(`Mcp${stage.componentSuffix}`, {
    cluster,
    image: { context: ".", dockerfile: "apps/mcp/Dockerfile" },
    architecture: "arm64",
    cpu: "0.25 vCPU",
    memory: "0.5 GB",
    scaling: stage.mcpScaling,
    ...(stage.spot ? { capacity: "spot" as const } : {}),
    ...containerConfig(deps),
    logging: { retention: stage.logRetention },
    loadBalancer: {
      instance: alb,
      rules: stage.mcpRules.map((rule) => ({
        listen: serviceListener(),
        forward,
        conditions: { path: rule.path },
        priority: rule.priority,
      })),
      health: {
        [forward]: {
          path: stage.healthPath,
          interval: "15 seconds",
          successCodes: "200",
        },
      },
    },
  });
}
