// The edge rate limit's web ACLs (m1-hosted-connector design D5, task 8.1).
// dev and prod: a REGIONAL web ACL associated with the environment's ALB (the
// MCP paths of the stage and of every preview on dev's ALB), and a CLOUDFRONT
// web ACL for the web distribution, which AWS requires in us-east-1 (ADR 0001
// amendment 4: the second exception to the one-region rule, like ACM for
// CloudFront; it holds no data). Previews borrow both (design D5): dev's ALB
// carries dev's REGIONAL ACL, and dev publishes its CLOUDFRONT ACL's ARN
// (`/a2h/shared/web-acl-cloudfront-arn`) for each preview's distribution.
// Arguments: edge.ts (pure, tested).
import type { StageInfo } from "./config.ts";
import { edgeWebAclArgs } from "./edge.ts";

/** The CloudFront distribution `sst.aws.Nextjs("Web")` creates: `${name}Cdn` (ssr-site.ts createDistribution). */
export const WEB_CDN_NAME = "WebCdn";

export function createEdgeAcls(stage: StageInfo, alb: sst.aws.Alb): { cloudfrontAclArn: $util.Output<string> } {
  if (!stage.ownsSharedResources) {
    throw new Error(`Stage ${stage.name} creates no web ACL: previews borrow dev's (design D5).`);
  }
  const regional = new aws.wafv2.WebAcl("McpEdgeAcl", edgeWebAclArgs(stage, "REGIONAL"));
  new aws.wafv2.WebAclAssociation("McpEdgeAclAlb", { resourceArn: alb.arn, webAclArn: regional.arn });
  // SST's own us-east-1 provider (helpers/provider.ts useProvider) is not
  // exported to programs; this one carries only the region, as the program's
  // default provider carries only eu-west-3 (sst.config.ts).
  const usEast1 = new aws.Provider("AwsUsEast1", { region: "us-east-1" });
  const cloudfront = new aws.wafv2.WebAcl("WebEdgeAcl", edgeWebAclArgs(stage, "CLOUDFRONT"), { provider: usEast1 });
  return { cloudfrontAclArn: cloudfront.arn };
}

/**
 * Attach the CLOUDFRONT web ACL to the web app's distribution without editing
 * web.ts: a component transform on `sst.aws.Cdn` (SST 4.17.2
 * `component.ts` `$transform`: for an `sst:` type it runs on the component's
 * arguments before construction), limited to the distribution named
 * WEB_CDN_NAME. `CdnArgs.webAclArn` becomes the distribution's `webAclId`
 * (cdn.ts). Register before createWeb(). If web.ts later passes
 * `transform.cdn.webAclArn` itself, remove this.
 */
export function attachWebAcl(webAclArn: $util.Input<string>) {
  $transform(sst.aws.Cdn, (args, _opts, name) => {
    if (name === WEB_CDN_NAME) args.webAclArn = webAclArn;
  });
}
