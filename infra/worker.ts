// pg-boss worker on Fargate. No load balancer, one task on every stage.
import { containerConfig, type ServiceDeps } from "./mcp.ts";

export function createWorker(deps: ServiceDeps) {
  const { stage, cluster } = deps;
  return new sst.aws.Service(`Worker${stage.componentSuffix}`, {
    cluster,
    image: { context: ".", dockerfile: "apps/worker/Dockerfile" },
    architecture: "arm64",
    cpu: "0.25 vCPU",
    memory: "0.5 GB",
    scaling: { min: 1, max: 1 },
    ...(stage.spot ? { capacity: "spot" as const } : {}),
    ...containerConfig(deps),
    logging: { retention: stage.logRetention },
  });
}
