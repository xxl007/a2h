// What apps/web reads from its environment (infra/web.ts) and what it refuses.
import { describe, expect, test } from "vitest";
import { webConfigFromEnv } from "../src/config";

const SECRET = "s".repeat(32) + "A1";
const base = {
  STAGE: "pr-12",
  MCP_URL: "https://mcp.dev.a2h-protocol.org/pr-12/mcp",
  AUTH_ISSUER: "https://pr-12.dev.a2h-protocol.org/api/auth",
  BETTER_AUTH_SECRET: SECRET,
  STORAGE_PREFIX: "pr-12/",
  UPLOADS_BUCKET: "a2h-uploads-bucket",
  PRINCIPAL_CURRENCY: "EUR",
  PRINCIPAL_MONTHLY_BUDGET_MINOR: "50000",
  PRINCIPAL_PER_REQUEST_CAP_MINOR: "6000",
  PRINCIPAL_ASK_FIRST_ABOVE_MINOR: "none",
  PRINCIPAL_DAILY_REQUEST_LIMIT: "50",
  PRINCIPAL_THROTTLED_DAILY_LIMIT: "5",
};

describe("webConfigFromEnv", () => {
  test("reads a preview's environment", () => {
    const c = webConfigFromEnv(base);
    expect(c.stage).toBe("pr-12");
    expect(c.issuer).toBe("https://pr-12.dev.a2h-protocol.org/api/auth");
    expect(c.baseURL).toBe("https://pr-12.dev.a2h-protocol.org");
    expect(c.mcpUrl).toBe("https://mcp.dev.a2h-protocol.org/pr-12/mcp");
    expect(c.mailSinkPrefix).toBe("tmp/pr-12/");
    expect(c.defaultPolicy).toEqual({
      currency: "EUR",
      monthly_budget_minor: 50000,
      per_request_cap_minor: 6000,
      ask_first_above_minor: null,
      daily_request_limit: 50,
      throttled_daily_limit: 5,
    });
    expect(c.allowlist).toEqual({ parameter: undefined, fallback: "" });
    expect(c.clients).toEqual([]);
    expect(c.stageName).toBe("pr-12");
  });

  test("prod shows no stage name and needs a sender", () => {
    const prod = { ...base, STAGE: "prod", STORAGE_PREFIX: "prod/", MCP_URL: "https://mcp.a2h-protocol.org/mcp", AUTH_ISSUER: "https://a2h-protocol.org/api/auth" };
    expect(() => webConfigFromEnv(prod)).toThrow(/EMAIL_FROM/);
    const c = webConfigFromEnv({ ...prod, EMAIL_FROM: "A2H <sign-in@a2h-protocol.org>" });
    expect(c.stageName).toBeUndefined();
    expect(c.emailFrom).toBe("A2H <sign-in@a2h-protocol.org>");
  });

  test("the issuer is <origin>/api/auth over https (http on loopback only)", () => {
    expect(() => webConfigFromEnv({ ...base, AUTH_ISSUER: "https://x.example/auth" })).toThrow(/AUTH_ISSUER/);
    expect(() => webConfigFromEnv({ ...base, AUTH_ISSUER: "http://x.example/api/auth" })).toThrow(/AUTH_ISSUER/);
    expect(webConfigFromEnv({ ...base, AUTH_ISSUER: "http://localhost:3000/api/auth" }).baseURL).toBe("http://localhost:3000");
  });

  test("AUTH_ISSUER and an https MCP_URL are required (a stage without a domain has no authorization server)", () => {
    const { AUTH_ISSUER: _drop, ...rest } = base;
    void _drop;
    expect(() => webConfigFromEnv(rest)).toThrow(/AUTH_ISSUER is not set/);
    expect(() => webConfigFromEnv({ ...base, MCP_URL: "http://a2h-alb-1.eu-west-3.elb.amazonaws.com/pr-12/mcp" })).toThrow(/MCP_URL must be https/);
  });

  test("refuses a short secret, a bad stage, a missing MCP URL", () => {
    expect(() => webConfigFromEnv({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => webConfigFromEnv({ ...base, STAGE: "staging" })).toThrow(/STAGE/);
    expect(() => webConfigFromEnv({ ...base, MCP_URL: "" })).toThrow(/MCP_URL/);
  });

  test("no error message carries a value", () => {
    try {
      webConfigFromEnv({ ...base, BETTER_AUTH_SECRET: "tooShortSecretValue" });
    } catch (e) {
      expect((e as Error).message).not.toContain("tooShortSecretValue");
    }
    try {
      webConfigFromEnv({ ...base, PRINCIPAL_MONTHLY_BUDGET_MINOR: "-77" });
    } catch (e) {
      expect((e as Error).message).toMatch(/PRINCIPAL_MONTHLY_BUDGET_MINOR/);
      expect((e as Error).message).not.toContain("-77");
    }
  });

  test("allow-list parameter name and fallback", () => {
    const c = webConfigFromEnv({ ...base, ALLOWLIST_PARAMETER: "/a2h/shared/principal-allowlist", PRINCIPAL_ALLOWLIST: "a@example.com" });
    expect(c.allowlist).toEqual({ parameter: "/a2h/shared/principal-allowlist", fallback: "a@example.com" });
  });

  test("pre-registered clients from AUTH_CLIENTS_JSON", () => {
    const clients = [
      { client_id: "chatgpt", client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], client_secret_sha256: "q".repeat(43) },
      { client_id: "inspector", client_name: "MCP Inspector", redirect_uris: ["http://localhost:6274/oauth/callback"] },
    ];
    const c = webConfigFromEnv({ ...base, AUTH_CLIENTS_JSON: JSON.stringify(clients) });
    expect(c.clients).toEqual(clients);
    expect(() => webConfigFromEnv({ ...base, AUTH_CLIENTS_JSON: "[{}]" })).toThrow(/AUTH_CLIENTS_JSON/);
    expect(() => webConfigFromEnv({ ...base, AUTH_CLIENTS_JSON: JSON.stringify([{ ...clients[1], redirect_uris: ["ftp://x"] }]) })).toThrow(/AUTH_CLIENTS_JSON/);
  });
});
