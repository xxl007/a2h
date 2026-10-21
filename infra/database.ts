// Aurora Serverless v2, PostgreSQL 17, database `a2h`.
// dev: shared with pr-* (schema per stage, created/dropped by CI through the
// RDS Data API), scales to 0 ACU and pauses after 10 minutes.
// prod: its own cluster, min 0.5 ACU, never pauses, no Data API.
import { dbCredentials, prDbSecretName, type DbCredentials } from "./access.ts";
import type { StageInfo } from "./config.ts";

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
    // Only CI's schema create/drop uses the Data API; business code connects
    // by connection string only.
    dataApi: stage.kind === "dev",
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
  ssm: { DB_PASSWORD: $util.Input<string> };
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
 * name at deploy time; a missing secret fails the deploy.
 */
export async function previewAccess(stage: StageInfo, clusterId: string): Promise<DbAccess> {
  const cluster = aws.rds.getClusterOutput({ clusterIdentifier: clusterId });
  const secretName = prDbSecretName(stage);
  let secretArn: string;
  try {
    secretArn = (await aws.secretsmanager.getSecret({ name: secretName })).arn;
  } catch (cause) {
    throw new Error(
      `Secret ${secretName} is missing or unreadable. The preview workflow creates it with .github/scripts/pr-schema.sh create before sst deploy.`,
      { cause },
    );
  }
  const creds: DbCredentials = dbCredentials(stage, { kind: "pr-login", secretArn });
  return {
    endpoint: {
      host: cluster.endpoint.apply(hostOnly),
      port: cluster.port.apply((p) => String(p)),
      name: cluster.databaseName,
    },
    environment: creds.environment,
    ssm: creds.ssm,
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
    environment: {
      DB_HOST: access.endpoint.host,
      DB_PORT: access.endpoint.port,
      DB_NAME: access.endpoint.name,
      DB_USER: access.environment.DB_USER,
      DB_SCHEMA: stage.dbSchema,
    },
    ssm: { DB_PASSWORD: access.ssm.DB_PASSWORD },
  };
}
