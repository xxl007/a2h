// Aurora Serverless v2, PostgreSQL 17, database `a2h`.
// dev: shared with pr-* (schema per stage, created/dropped by CI through the
// RDS Data API), scales to 0 ACU and pauses after 10 minutes.
// prod: its own cluster, min 0.5 ACU, never pauses.
// Both have the RDS Data API (design D2 of m1-hosted-connector): CI migrates
// through it, and the web Lambda will reach its schema through it.
import {
  dbCredentials,
  prDbSecretName,
  previewDbCredentials,
  type ExecutionSecretSource,
  type SecretLookup,
} from "./access.ts";
import type { StageInfo } from "./config.ts";
import { databaseEnvironment } from "./service-env.ts";

export function createDatabase(stage: StageInfo, vpc: sst.aws.Vpc): sst.aws.Aurora {
  return new sst.aws.Aurora("Database", {
    engine: "postgres",
    version: "17",
    vpc,
    database: "a2h",
    scaling:
      stage.kind === "prod"
        ? { min: "0.5 ACU", max: "4 ACU" }
        : { min: "0 ACU", max: "4 ACU", pauseAfter: "10 minutes" },
    // CI (schema create/drop, migrations) and, from m1-hosted-connector D2,
    // the web Lambda use the Data API; the services connect by connection
    // string. A cluster setting only: it deploys nothing on prod by itself.
    dataApi: true,
  });
}

/** Where to connect. Holds no credential. */
export interface DbEndpoint {
  host: $util.Input<string>;
  port: $util.Input<string>;
  name: $util.Input<string>;
}

/** What a container receives: endpoint plus credentials (password via `ssm` only). */
export interface DbAccess {
  endpoint: DbEndpoint;
  environment: { DB_USER: $util.Input<string> };
  /** Empty only for a pr stage being removed whose secret is gone (access.ts previewDbCredentials). */
  ssm: { DB_PASSWORD: $util.Input<string> } | Record<string, never>;
  /**
   * Where DB_PASSWORD comes from, for the Fargate execution role's inline
   * policy (access.ts executionRolePolicy, built in mcp.ts containerConfig).
   */
  executionSource: $util.Input<ExecutionSecretSource>;
}

function hostOnly(endpoint: string | undefined): string {
  const host = endpoint?.split(":")[0];
  if (!host) throw new Error("Aurora cluster has no writer endpoint");
  return host;
}

/** dev and prod: the cluster this stage owns, master user (M0). */
export function masterAccess(stage: StageInfo, db: sst.aws.Aurora): DbAccess {
  const creds = $util
    .all([db.username, db.secretArn])
    .apply(([username, secretArn]) =>
      dbCredentials(stage, { kind: "master", username, secretArn }),
    );
  return {
    endpoint: {
      host: db.host.apply(hostOnly),
      port: db.port.apply((p) => String(p)),
      name: db.database,
    },
    environment: { DB_USER: creds.apply((c) => c.environment.DB_USER) },
    ssm: { DB_PASSWORD: creds.apply((c) => c.ssm.DB_PASSWORD) },
    executionSource: db.secretArn.apply((secretArn): ExecutionSecretSource => ({ kind: "master", secretArn })),
  };
}

/**
 * pr-<n>: dev's cluster through the RDS data source, not `Aurora.get`.
 * `Aurora.get` reads the master secret's value (getSecretVersion) to fill its
 * `password` property, which would put the master password in the preview's
 * state. The data source returns the endpoint only.
 *
 * Credentials: login `pr_<n>` and secret `a2h/pr-<n>/db`, which the preview
 * workflow creates (pr-schema.sh create) before `sst deploy`. Looked up by
 * name while the program runs; a missing secret fails every command except
 * `sst remove` (`command` is SST's `$cli.command`), where it is absent for a
 * PR that never deployed or for a teardown re-run after the drop.
 */
export async function previewAccess(
  stage: StageInfo,
  clusterId: string,
  command: string,
): Promise<DbAccess> {
  const cluster = aws.rds.getClusterOutput({ clusterIdentifier: clusterId });
  let lookup: SecretLookup;
  try {
    const secret = await aws.secretsmanager.getSecret({ name: prDbSecretName(stage) });
    lookup = { found: true, arn: secret.arn };
  } catch (cause) {
    lookup = { found: false, cause };
  }
  const { mode, credentials: creds } = previewDbCredentials(stage, command, lookup);
  if (mode === "removing-without-secret") {
    console.warn(`${prDbSecretName(stage)} not found; tolerated because the stage is being removed.`);
  }
  return {
    endpoint: {
      host: cluster.endpoint.apply(hostOnly),
      port: cluster.port.apply((p) => String(p)),
      name: cluster.databaseName,
    },
    environment: creds.environment,
    ssm: creds.ssm,
    executionSource: aws
      .getCallerIdentityOutput()
      .accountId.apply((accountId): ExecutionSecretSource => ({ kind: "pr-login", accountId })),
  };
}

/**
 * Connection settings for a container. The password is never in plain
 * `environment`: ECS injects it from Secrets Manager (`DB_PASSWORD`, via the
 * task's `secrets.valueFrom`), and the app-side adapter in step 5 composes
 * DATABASE_URL in process. We deliberately do not `link` the database: SST's
 * link would put the password in the task definition's plain environment.
 */
export function databaseEnv(access: DbAccess, stage: StageInfo) {
  return {
    // DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_SCHEMA, DB_JOBS_SCHEMA (service-env.ts).
    environment: databaseEnvironment<$util.Input<string>>(access.endpoint, access.environment.DB_USER, stage),
    ssm: access.ssm,
  };
}
