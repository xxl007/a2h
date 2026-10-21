// Aurora Serverless v2, PostgreSQL 17, database `a2h`.
// dev: shared with pr-* (schema per stage, created/dropped by CI through the
// RDS Data API), scales to 0 ACU and pauses after 10 minutes.
// prod: its own cluster, min 0.5 ACU, never pauses, no Data API.
import type { StageInfo } from "./config.ts";

export type Database = sst.aws.Aurora;

export function createDatabase(stage: StageInfo, vpc: sst.aws.Vpc): Database {
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

export function getDatabase(clusterId: string): Database {
  return sst.aws.Aurora.get("Database", clusterId);
}

/**
 * Connection settings for a container. The password is never in plain
 * `environment`: ECS injects it from Secrets Manager (`DB_PASSWORD`, via the
 * task's `secrets.valueFrom`), and the app-side adapter in step 5 composes
 * DATABASE_URL in process. We deliberately do not `link` the database: SST's
 * link would put the password in the task definition's plain environment.
 */
export function databaseEnv(db: Database, stage: StageInfo) {
  return {
    environment: {
      DB_HOST: db.host.apply((h) => {
        if (!h) throw new Error("Aurora cluster has no writer endpoint");
        return h;
      }),
      DB_PORT: db.port.apply((p) => String(p)),
      DB_NAME: db.database,
      DB_USER: db.username,
      DB_SCHEMA: stage.dbSchema,
    },
    ssm: {
      DB_PASSWORD: $interpolate`${db.secretArn}:password::`,
    },
  };
}
