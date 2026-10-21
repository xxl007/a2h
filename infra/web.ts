// apps/web on CloudFront + Lambda through OpenNext (ADR 0001, decision 1).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { domain, hostnames, type StageInfo } from "./config.ts";

export const WEB_NOT_DEPLOYED = "not deployed (apps/web has no Next.js app yet)";

/**
 * The owner deploys `dev` once before any Next.js app exists (step 4), so that
 * pr-* previews in step 5 find the shared resources. Until apps/web has a
 * next.config, the Web component is skipped. Step 5 removes nothing here: it
 * adds the app and this component starts deploying.
 */
export function hasNextApp(): boolean {
  const dir = join($cli.paths.root, "apps", "web");
  return ["next.config.ts", "next.config.mjs", "next.config.js"].some((f) =>
    existsSync(join(dir, f)),
  );
}

export function createWeb(
  stage: StageInfo,
  deps: { uploads: sst.aws.Bucket; mcpUrl: $util.Input<string> },
): sst.aws.Nextjs | undefined {
  if (!hasNextApp()) return undefined;
  return new sst.aws.Nextjs("Web", {
    path: "apps/web",
    // eu-west-3 only (no `regions`): SSR and data access stay in the EU.
    server: {
      runtime: "nodejs22.x",
      architecture: "arm64",
      memory: "1024 MB",
      timeout: "20 seconds",
    },
    warm: stage.warm,
    ...(domain ? { domain: hostnames(stage, domain).web } : {}),
    // Database deliberately not linked in M0: the Lambda is outside the VPC
    // (Aurora is private) and SST's link would place the password in the
    // function's environment. See infra/README.md, open items.
    link: [deps.uploads],
    environment: {
      STAGE: stage.name,
      DB_SCHEMA: stage.dbSchema,
      STORAGE_PREFIX: stage.storagePrefix,
      MCP_URL: deps.mcpUrl,
    },
  });
}
