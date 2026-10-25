// A2H MCP server on Fargate behind the environment's ALB.
// Routing: dev/prod `/mcp`, `/mcp/*`, `/healthz` (priorities 49000-49002);
// pr-<n> `/pr-<n>/*` (priority 100 + n). See config.ts stageInfo.
import { MCP_PORT, type StageInfo } from "./config.ts";
import { serviceListener } from "./cluster.ts";
import { databaseEnv, type DbAccess } from "./database.ts";
import { storageArgs, type StorageGrant } from "./storage.ts";

export interface ServiceDeps {
  stage: StageInfo;
  cluster: sst.aws.Cluster;
  /** Endpoint and credentials: master on dev/prod, `pr_<n>` on previews. */
  db: DbAccess;
  /** `link` on dev/prod; prefix-scoped object permissions on previews. */
  storage: StorageGrant;
  email: sst.aws.Email | undefined;
}

/** Environment, secrets, links and permissions shared by the MCP and worker containers. */
export function containerConfig({ stage, db, storage, email }: ServiceDeps) {
  const database = databaseEnv(db, stage);
  const store = storageArgs(storage);
  return {
    environment: {
      PORT: String(MCP_PORT),
      STAGE: stage.name,
      MCP_BASE_PATH: stage.mcpBasePath,
      STORAGE_PREFIX: stage.storagePrefix,
      ...store.environment,
      ...database.environment,
    },
    ssm: database.ssm,
    // `link` grants the task role least-privilege IAM on these resources.
    link: [...store.link, ...(email ? [email] : [])],
    permissions: store.permissions,
    transform: {
      // Object form: SST merges it over its defaults (`{ ...args, ...transform }`,
      // component.ts), so only `inlinePolicies` changes. It replaces SST's
      // `ReadSsmAndSecrets` (GetSecretValue and ssm:GetParameter* on `*`)
      // with GetSecretValue on the one DB secret. `managedPolicyArns`
      // (AmazonECSTaskExecutionRolePolicy: ECR pull, logs) and
      // `assumeRolePolicy` stay as SST sets them; the boundary still comes
      // from the $transform in sst.config.ts.
      executionRole: {
        inlinePolicies: [{ name: "inline", policy: db.executionPolicy }],
      },
    },
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
    // Contract amendment 1: `sst deploy` waits for a steady, healthy service
    // (ECS waitForSteadyState), so an unhealthy deploy fails the job.
    wait: true,
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
