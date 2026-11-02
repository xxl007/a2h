// The environment infra gives the web Lambda (infra/web-env.ts, infra/web.ts)
// is the environment apps/web reads: parsed here with the app's own readers.
import { describe, expect, test } from "vitest";
import { stageInfo } from "../../../infra/config";
import { webPlainEnvironment } from "../../../infra/web-env";
import { dataApiConfigFromEnv } from "../infra/db";
import { webConfigFromEnv } from "../src/config";

const ARNS = {
  DB_CLUSTER_ARN: "arn:aws:rds:eu-west-3:123456789012:cluster:a2h-dev-databasecluster-abc",
  DB_SECRET_ARN: "arn:aws:secretsmanager:eu-west-3:123456789012:secret:a2h/pr-12/db-XyZ789",
};

describe("infra -> apps/web environment", () => {
  for (const name of ["dev", "pr-12", "prod"]) {
    test(`${name}: parsed by webConfigFromEnv and dataApiConfigFromEnv`, () => {
      const stage = stageInfo(name);
      const env = {
        ...webPlainEnvironment(stage, { domain: "a2h-protocol.org", emailSender: "a2h-protocol.org" }),
        ...ARNS,
        STAGE: stage.name,
        STORAGE_PREFIX: stage.storagePrefix,
        UPLOADS_BUCKET: "a2h-dev-uploadsbucket-x",
        MCP_URL: name === "prod" ? "https://mcp.a2h-protocol.org/mcp" : `https://mcp.dev.a2h-protocol.org${stage.mcpBasePath}`,
        BETTER_AUTH_SECRET: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA==",
      };
      const config = webConfigFromEnv(env);
      const host = { dev: "dev.a2h-protocol.org", "pr-12": "pr-12.dev.a2h-protocol.org", prod: "a2h-protocol.org" }[name];
      expect(config.issuer).toBe(`https://${host}/api/auth`);
      expect(config.mailSinkPrefix).toBe(`tmp/${stage.storagePrefix}`);
      // One parameter per stage (D7, group 8.3 fact): dev the shared name, a preview its own, prod its own.
      expect(config.allowlist.parameter).toBe({ dev: "/a2h/shared/principal-allowlist", "pr-12": "/a2h/pr-12/principal-allowlist", prod: "/a2h/prod/principal-allowlist" }[name]);
      expect(dataApiConfigFromEnv(env).schema).toBe(stage.dbSchema);
    });
  }

  test("without a domain there is no issuer: the app refuses to start its authorization server (no https MCP URL either)", () => {
    const stage = stageInfo("pr-12");
    const env = { ...webPlainEnvironment(stage, {}), STAGE: "pr-12", STORAGE_PREFIX: "pr-12/", UPLOADS_BUCKET: "b", MCP_URL: "http://a2h-alb.elb.amazonaws.com/pr-12/mcp", BETTER_AUTH_SECRET: "x".repeat(44) };
    expect(() => webConfigFromEnv(env)).toThrow(/MCP_URL must be https|AUTH_ISSUER/);
  });
});
