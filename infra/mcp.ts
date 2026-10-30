// A2H MCP server on Fargate behind the environment's ALB.
// Routing: dev/prod `/mcp`, `/mcp/*`, `/healthz` (priorities 49000-49002);
// pr-<n> `/pr-<n>/*` (priority 100 + n). See config.ts stageInfo.
import { executionRolePolicy } from "./access.ts";
import { MCP_PORT, type StageInfo } from "./config.ts";
import { serviceListener } from "./cluster.ts";
import { databaseEnv, type DbAccess } from "./database.ts";
import { authEnvironment, plainEnvironment } from "./service-env.ts";
import type { StageSecrets } from "./stage-secrets-resources.ts";
import { secretKindsFor, secretsEnvironment, type Service } from "./stage-secrets.ts";
import { storageArgs, type StorageGrant } from "./storage.ts";

export interface ServiceDeps {
  stage: StageInfo;
  cluster: sst.aws.Cluster;
  /** Endpoint and credentials: master on dev/prod, `pr_<n>` on previews. */
  db: DbAccess;
  /** `link` on dev/prod; prefix-scoped object permissions on previews. */
  storage: StorageGrant;
  email: sst.aws.Email | undefined;
  /** `a2h/<stage>/signing` and `a2h/<stage>/approval`, created by the stage (stage-secrets-resources.ts). */
  secrets: StageSecrets;
}

/**
 * Environment, secrets, links and permissions of one container. Plain
 * environment by name in service-env.ts; secrets only through `ssm` (ECS
 * `secrets.valueFrom`), never in `environment`: DB_PASSWORD, and the stage
 * keys this service receives (stage-secrets.ts SECRET_SERVICES).
 */
/** What only the mcp service needs: the ALB base URL and the web app's base URL (its authorization server). */
export interface McpUrls {
  albBaseUrl: $util.Input<string>;
  webBaseUrl: $util.Input<string>;
}

export function containerConfig(service: Service, { stage, db, storage, email, secrets }: ServiceDeps, urls?: McpUrls) {
  const database = databaseEnv(db, stage);
  const store = storageArgs(storage);
  const kinds = secretKindsFor(service);
  const keySecrets = $util
    .all([secrets.signing.arn, secrets.signing.versionId, secrets.approval.arn, secrets.approval.versionId])
    .apply(([signingArn, signingVersion, approvalArn, approvalVersion]) =>
      secretsEnvironment(stage, service, {
        signing: { arn: signingArn, versionId: signingVersion },
        approval: { arn: approvalArn, versionId: approvalVersion },
      }),
    );
  const stageSecretArns = $util.all(kinds.map((kind) => secrets[kind].arn));
  const executionPolicy = $util
    .all([$output(db.executionSource), stageSecretArns])
    .apply(([source, arns]) => JSON.stringify(executionRolePolicy(stage, source, arns)));
  // The mcp service's trust relationship (m1-hosted-connector D3): its resource URL, issuer and JWKS.
  const auth = urls ? $util.all([urls.albBaseUrl, urls.webBaseUrl]).apply(([alb, web]) => authEnvironment(stage, alb, web)) : undefined;
  return {
    environment: {
      ...plainEnvironment(service, stage),
      ...(auth
        ? {
            MCP_RESOURCE_URL: auth.apply((a) => a.MCP_RESOURCE_URL),
            AUTH_ISSUER: auth.apply((a) => a.AUTH_ISSUER),
            AUTH_JWKS_URL: auth.apply((a) => a.AUTH_JWKS_URL),
          }
        : {}),
      ...store.environment,
      ...database.environment,
    },
    ssm: $util.all([database.ssm, keySecrets]).apply(([dbSsm, keys]) => ({ ...dbSsm, ...keys })),
    // `link` grants the task role least-privilege IAM on these resources.
    link: [...store.link, ...(email ? [email] : [])],
    permissions: store.permissions,
    transform: {
      // Object form: SST merges it over its defaults (`{ ...args, ...transform }`,
      // component.ts), so only `inlinePolicies` changes. It replaces SST's
      // `ReadSsmAndSecrets` (GetSecretValue and ssm:GetParameter* on `*`)
      // with GetSecretValue on the DB secret and this service's stage
      // secrets, by ARN. `managedPolicyArns` (AmazonECSTaskExecutionRolePolicy:
      // ECR pull, logs) and `assumeRolePolicy` stay as SST sets them; the
      // boundary still comes from the $transform in sst.config.ts.
      executionRole: {
        inlinePolicies: [{ name: "inline", policy: executionPolicy }],
      },
    },
  };
}

export function createMcp(deps: ServiceDeps, alb: sst.aws.Alb, urls: McpUrls) {
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
    ...containerConfig("mcp", deps, urls),
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
