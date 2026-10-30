// Edge rate limit (m1-hosted-connector design D5, task 8.1) and the allow-list
// parameter (design D7, task 8.2). Spec platform/hosted-endpoint, "Edge rate
// limit per source address": the MCP and authorization paths are limited per
// source address with a limit configured per stage, a source over the limit
// gets 429, and the health path is never limited. The pure rule (edge.ts) is
// asserted field by field; the SST wiring (waf.ts, allowlist.ts) runs against
// stubbed globals that record what `sst deploy` would receive. The 429 under
// a real flood is QA's task 8.4 on a preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWLIST_NONE, limitsFor, stageInfo } from "../config.ts";
import { EDGE_SCOPE_REGEX, EDGE_WINDOW_SECONDS, edgeWebAclArgs } from "../edge.ts";
import { createAllowlist } from "../allowlist.ts";
import { attachWebAcl, createEdgeAcls, WEB_CDN_NAME } from "../waf.ts";

const scope = new RegExp(EDGE_SCOPE_REGEX);

test("scope: the MCP paths of every stage, the well-known metadata and /api/auth are limited", () => {
  for (const path of [
    "/mcp",
    "/mcp/",
    "/mcp/anything",
    "/pr-12/mcp",
    "/pr-12/mcp/",
    "/pr-19899/mcp/x",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/pr-12/mcp",
    "/.well-known/oauth-authorization-server/api/auth",
    "/.well-known/openid-configuration/api/auth",
    "/api/auth",
    "/api/auth/",
    "/api/auth/sign-in/magic-link",
    "/api/auth/jwks",
    "/api/auth/mcp/register",
    "/api/auth/oauth2/token",
  ]) {
    assert.match(path, scope, path);
  }
});

test("scope: health is excluded, and so are the pages and assets of the web app", () => {
  for (const path of [
    "/healthz",
    "/pr-12/healthz",
    "/healthz/",
    "/",
    "/sign-in",
    "/sign-in/sent",
    "/consent",
    "/account/clients",
    "/_next/static/chunks/main.js",
    "/mcpx",
    "/pr-12/mcpx",
    "/pr-0/mcp",
    "/pr-12/other",
    "/api/authx",
    "/api/other",
    "/.well-known/security.txt",
  ]) {
    assert.doesNotMatch(path, scope, path);
  }
});

test("rule: rate-based per source address, the stage's limit per 5 minutes, scoped to the paths, 429 when over", () => {
  for (const s of ["dev", "prod"]) {
    for (const kind of ["REGIONAL", "CLOUDFRONT"] as const) {
      const args = edgeWebAclArgs(stageInfo(s), kind);
      assert.equal(args.scope, kind);
      assert.deepEqual(args.defaultAction, { allow: {} }, "everything not over the limit passes");
      assert.equal(args.rules.length, 1);
      const [rule] = args.rules;
      assert.ok(rule);
      assert.equal(rule.priority, 0);
      assert.deepEqual(rule.action, { block: { customResponse: { responseCode: 429 } } });
      const rate = rule.statement.rateBasedStatement;
      assert.equal(rate.limit, limitsFor(stageInfo(s)).edgeRequestsPer5Minutes);
      assert.equal(rate.limit, 600);
      assert.equal(rate.aggregateKeyType, "IP");
      assert.equal(rate.evaluationWindowSec, EDGE_WINDOW_SECONDS);
      assert.equal(EDGE_WINDOW_SECONDS, 300);
      const match = rate.scopeDownStatement.regexMatchStatement;
      assert.equal(match.regexString, EDGE_SCOPE_REGEX);
      assert.deepEqual(match.fieldToMatch, { uriPath: {} }, "the path only, never the query string");
      // Decode and normalise before matching, so `/%6Dcp` or `//mcp` count too.
      assert.deepEqual(match.textTransformations, [
        { priority: 0, type: "URL_DECODE" },
        { priority: 1, type: "NORMALIZE_PATH" },
      ]);
      assert.equal(rule.visibilityConfig.cloudwatchMetricsEnabled, true);
      assert.equal(args.visibilityConfig.cloudwatchMetricsEnabled, true);
      // D10: no sample of requests (headers with bearer tokens, client addresses) is kept.
      assert.equal(rule.visibilityConfig.sampledRequestsEnabled, false);
      assert.equal(args.visibilityConfig.sampledRequestsEnabled, false);
      assert.match(args.name, new RegExp(`^a2h-${s}-(mcp|web)-edge$`));
      assert.match(args.name, /^[\w-]{1,128}$/, "WAF name charset");
      assert.match(rule.visibilityConfig.metricName, /^[\w-]{1,128}$/);
    }
  }
  // AWS: a regex string is at most 512 characters.
  assert.ok(EDGE_SCOPE_REGEX.length <= 512);
  assert.notEqual(edgeWebAclArgs(stageInfo("dev"), "REGIONAL").name, edgeWebAclArgs(stageInfo("prod"), "REGIONAL").name);
  assert.notEqual(edgeWebAclArgs(stageInfo("dev"), "REGIONAL").name, edgeWebAclArgs(stageInfo("dev"), "CLOUDFRONT").name);
  // Previews create no web ACL: they borrow dev's.
  assert.throws(() => edgeWebAclArgs(stageInfo("pr-12"), "REGIONAL"), /borrow/);
});

// --- SST wiring against recording stubs ---------------------------------------

type Args = Record<string, unknown>;
interface Made {
  type: string;
  name: string;
  args: Args;
  opts?: Args;
}

function stubGlobals() {
  const made: Made[] = [];
  const transforms: { type: unknown; cb: (args: Args, opts: Args, name: string) => void }[] = [];
  const recorder = (type: string) =>
    class {
      arn: string;
      constructor(name: string, args: Args, opts?: Args) {
        made.push({ type, name, args, ...(opts ? { opts } : {}) });
        this.arn = `arn:${type}:${name}`;
      }
    };
  const Cdn = recorder("sst.aws.Cdn");
  const g = globalThis as unknown as Record<string, unknown>;
  g.aws = {
    Provider: recorder("aws.Provider"),
    wafv2: { WebAcl: recorder("aws.wafv2.WebAcl"), WebAclAssociation: recorder("aws.wafv2.WebAclAssociation") },
    ssm: { Parameter: recorder("aws.ssm.Parameter") },
  };
  g.sst = { aws: { Cdn } };
  g.$transform = (type: unknown, cb: (args: Args, opts: Args, name: string) => void) => transforms.push({ type, cb });
  return { made, transforms, Cdn };
}

const fakeAlb = { arn: "arn:aws:elasticloadbalancing:eu-west-3:123456789012:loadbalancer/app/a2h-dev/abc" } as unknown as sst.aws.Alb;

test("dev and prod: a REGIONAL web ACL associated with the ALB, and a CLOUDFRONT one in us-east-1", () => {
  for (const s of ["dev", "prod"]) {
    const { made } = stubGlobals();
    const stage = stageInfo(s);
    const out = createEdgeAcls(stage, fakeAlb);
    const acls = made.filter((m) => m.type === "aws.wafv2.WebAcl");
    assert.equal(acls.length, 2, s);
    const regional = acls.find((m) => m.args["scope"] === "REGIONAL");
    const cloudfront = acls.find((m) => m.args["scope"] === "CLOUDFRONT");
    assert.ok(regional && cloudfront, s);
    assert.deepEqual(regional.args, edgeWebAclArgs(stage, "REGIONAL"));
    assert.deepEqual(cloudfront.args, edgeWebAclArgs(stage, "CLOUDFRONT"));
    // REGIONAL: the program's default provider (eu-west-3).
    assert.equal(regional.opts?.["provider"], undefined);
    // CLOUDFRONT: AWS requires us-east-1 (ADR 0001 amendment 4, the second one-region exception).
    const provider = made.find((m) => m.type === "aws.Provider");
    assert.ok(provider);
    assert.deepEqual(provider.args, { region: "us-east-1" });
    assert.ok(cloudfront.opts?.["provider"], "CloudFront ACL on the us-east-1 provider");
    const assoc = made.filter((m) => m.type === "aws.wafv2.WebAclAssociation");
    assert.equal(assoc.length, 1, s);
    assert.deepEqual(assoc[0]?.args, { resourceArn: fakeAlb.arn, webAclArn: `arn:aws.wafv2.WebAcl:${regional.name}` });
    assert.equal(out.cloudfrontAclArn, `arn:aws.wafv2.WebAcl:${cloudfront.name}`);
  }
});

test("previews create no web ACL and no association: dev's ALB already carries dev's", () => {
  const { made } = stubGlobals();
  assert.throws(() => createEdgeAcls(stageInfo("pr-12"), fakeAlb), /borrow/);
  assert.deepEqual(made, []);
});

test("the CloudFront ACL reaches the web distribution only (Cdn named WebCdn), without touching web.ts", () => {
  const { transforms, Cdn } = stubGlobals();
  attachWebAcl("arn:aws:wafv2:us-east-1:123456789012:global/webacl/a2h-dev-web-edge/x");
  assert.equal(transforms.length, 1);
  assert.equal(transforms[0]?.type, Cdn);
  assert.equal(WEB_CDN_NAME, "WebCdn");
  const web: Args = { comment: "Web app" };
  transforms[0]?.cb(web, {}, "WebCdn");
  assert.equal(web["webAclArn"], "arn:aws:wafv2:us-east-1:123456789012:global/webacl/a2h-dev-web-edge/x");
  const other: Args = {};
  transforms[0]?.cb(other, {}, "OtherCdn");
  assert.equal(other["webAclArn"], undefined);
});

test("allow-list: dev creates /a2h/shared/principal-allowlist, prod /a2h/prod/…, SecureString, value never reverted", () => {
  for (const [s, name] of [
    ["dev", "/a2h/shared/principal-allowlist"],
    ["prod", "/a2h/prod/principal-allowlist"],
  ] as const) {
    const { made } = stubGlobals();
    createAllowlist(stageInfo(s));
    assert.equal(made.length, 1, s);
    const [p] = made;
    assert.equal(p?.type, "aws.ssm.Parameter");
    assert.equal(p?.args["name"], name);
    assert.equal(p?.args["type"], "SecureString");
    assert.equal(p?.args["value"], ALLOWLIST_NONE);
    // The owner's `aws ssm put-parameter --overwrite` is never reverted by a deploy.
    assert.deepEqual(p?.opts?.["ignoreChanges"], ["value"]);
  }
  const { made } = stubGlobals();
  assert.equal(createAllowlist(stageInfo("pr-12")), undefined);
  assert.deepEqual(made, [], "previews read dev's parameter and create none");
});
