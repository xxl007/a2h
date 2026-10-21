// ECS cluster and the one ALB per environment (dev, prod). pr-* stages
// attach listener rules to dev's ALB.
import { ALB_IDLE_TIMEOUT_SECONDS, domain, hostnames, type StageInfo } from "./config.ts";

export function createCluster(vpc: sst.aws.Vpc) {
  return new sst.aws.Cluster("Cluster", { vpc });
}

export function getCluster(clusterId: string, vpc: sst.aws.Vpc) {
  return sst.aws.Cluster.get("Cluster", { id: clusterId, vpc });
}

export function createAlb(stage: StageInfo, vpc: sst.aws.Vpc) {
  const host = domain ? hostnames(stage, domain).alb : undefined;
  return new sst.aws.Alb("Alb", {
    vpc,
    // HTTP always; HTTPS only once a domain exists (then 80 redirects to 443).
    listeners: host
      ? [
          { port: 80, protocol: "http" },
          { port: 443, protocol: "https" },
        ]
      : [{ port: 80, protocol: "http" }],
    ...(host ? { domain: host } : {}),
    transform: {
      loadBalancer: (args) => {
        // Spec mcp-transport, scenario "Idle stream survives": an idle
        // Streamable HTTP response must stay open for 61 minutes. The ALB
        // default (60 s) would cut it. SST has no idleTimeout argument, so it
        // is set on the underlying aws.lb.LoadBalancer.
        args.idleTimeout = ALB_IDLE_TIMEOUT_SECONDS;
      },
      listener: (args) => {
        if (host && args.port === 80) {
          args.defaultActions = [
            {
              type: "redirect",
              redirect: { port: "443", protocol: "HTTPS", statusCode: "HTTP_301" },
            },
          ];
        }
      },
    },
  });
}

export function getAlb(albArn: string) {
  return sst.aws.Alb.get("Alb", albArn);
}

/** Listener that service rules attach to: 443/https with a domain, else 80/http. */
export function serviceListener(): "443/https" | "80/http" {
  return domain ? "443/https" : "80/http";
}

/** Base URL (no trailing slash) under which MCP_BASE_PATH is served. */
export function albBaseUrl(stage: StageInfo, alb: sst.aws.Alb): $util.Output<string> {
  // Alb.get on pr-* only knows the DNS name, so derive the domain URL here.
  if (domain) return $output(`https://${hostnames(stage, domain).alb}`);
  return alb.url.apply((u) => u.replace(/\/$/, ""));
}
