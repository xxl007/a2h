// The edge rate limit (m1-hosted-connector design D5; spec
// platform/hosted-endpoint, "Edge rate limit per source address"). Pure: no
// SST globals, no I/O; the web ACL arguments are built here and asserted in
// infra/test/edge.test.ts, and waf.ts creates them on dev and prod.
//
// Field names and nesting: Pulumi AWS 7.20.0 (the provider SST 4.17.2 pins),
// `.sst/platform/node_modules/@pulumi/aws/types/input.d.ts`, interfaces
// `wafv2.WebAclRule`, `WebAclRuleStatementRateBasedStatement` (`limit`,
// `aggregateKeyType`, `evaluationWindowSec`, `scopeDownStatement`),
// `WebAclRuleStatementRateBasedStatementScopeDownStatementRegexMatchStatement`
// (`regexString`, `fieldToMatch`, `textTransformations`) and
// `WebAclRuleActionBlockCustomResponse` (`responseCode`). Two levels of
// nesting, within the provider's three for `rules`.
import { APP_NAME, limitsFor, type StageInfo } from "./config.ts";

/** WAF's rate window: the limit counts requests per source address over 5 minutes. */
export const EDGE_WINDOW_SECONDS = 300;

/**
 * The paths the limit applies to, as one regular expression on the URI path
 * (no query string), after URL decoding and path normalisation:
 * - the MCP endpoint of every stage on the ALB: `/mcp`, `/pr-<n>/mcp` and
 *   their subpaths;
 * - the OAuth discovery documents: `/.well-known/oauth-protected-resource…`
 *   (mcp service, ALB) and `/.well-known/oauth-authorization-server…`,
 *   `/.well-known/openid-configuration…` (web app, CloudFront);
 * - the authorization server: `/api/auth` and its subpaths (web app).
 * Everything else, the health paths (`/healthz`, `/pr-<n>/healthz`) first,
 * is never counted. One expression serves both web ACLs; a path that one
 * origin does not serve never reaches it through the other.
 * No look-around, back-reference or non-capturing group: plain PCRE that
 * WAF accepts. At most 512 characters (AWS limit, asserted in the test).
 */
export const EDGE_SCOPE_REGEX =
  "^/((pr-[1-9][0-9]*/)?mcp(/.*)?|\\.well-known/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(/.*)?|api/auth(/.*)?)$";

export type EdgeScope = "REGIONAL" | "CLOUDFRONT";

/**
 * The web ACL of an environment: allow by default, one rate-based rule per
 * source address (`aggregateKeyType: IP`; the ALB and CloudFront see the
 * client address, no forwarded header is trusted) on EDGE_SCOPE_REGEX, the
 * stage's `edgeRequestsPer5Minutes`, answered with 429 (WAF's default block
 * is 403; the spec asks for 429). WAF prefixes custom response headers with
 * `x-amzn-waf-`, so no `Retry-After` is sent: the window is 5 minutes.
 * REGIONAL for the ALB (mcp), CLOUDFRONT for the web distribution. dev and
 * prod own one of each; previews borrow dev's (design D5).
 */
export function edgeWebAclArgs(stage: StageInfo, scope: EdgeScope) {
  if (!stage.ownsSharedResources) {
    throw new Error(`Stage ${stage.name} creates no web ACL: previews borrow dev's (design D5).`);
  }
  const name = `${APP_NAME}-${stage.name}-${scope === "REGIONAL" ? "mcp" : "web"}-edge`;
  return {
    name,
    description: `A2H ${stage.name}: rate limit per source address on the MCP and authorization paths (m1-hosted-connector D5).`,
    scope,
    defaultAction: { allow: {} },
    rules: [
      {
        name: "rate-per-address",
        priority: 0,
        action: { block: { customResponse: { responseCode: 429 } } },
        statement: {
          rateBasedStatement: {
            limit: limitsFor(stage).edgeRequestsPer5Minutes,
            aggregateKeyType: "IP",
            evaluationWindowSec: EDGE_WINDOW_SECONDS,
            scopeDownStatement: {
              regexMatchStatement: {
                regexString: EDGE_SCOPE_REGEX,
                fieldToMatch: { uriPath: {} },
                textTransformations: [
                  { priority: 0, type: "URL_DECODE" },
                  { priority: 1, type: "NORMALIZE_PATH" },
                ],
              },
            },
          },
        },
        visibilityConfig: {
          cloudwatchMetricsEnabled: true,
          metricName: `${name}-rate-per-address`,
          sampledRequestsEnabled: false,
        },
      },
    ],
    visibilityConfig: {
      cloudwatchMetricsEnabled: true,
      metricName: name,
      // Off: a sample holds the request's headers, Authorization included,
      // and its client address (design D10: no token or PII kept).
      sampledRequestsEnabled: false,
    },
  };
}
