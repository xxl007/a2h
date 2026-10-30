// The allow-list of addresses that may sign in (m1-hosted-connector design
// D7, task 8.2): an SSM SecureString per environment, created by the deploy
// with ALLOWLIST_NONE and then owned by the owner, who sets it with one CLI
// line (docs/runbooks/aws-bootstrap.md). `ignoreChanges: ["value"]`: a later
// deploy never reverts the owner's value. dev creates the shared one, which
// previews read; prod its own; previews none. The web server function reads
// it (ALLOWLIST_PARAMETER and `ssm:GetParameter`, added in web.ts; see
// infra/README.md).
import { ALLOWLIST_NONE, allowlistParameterName, type StageInfo } from "./config.ts";

export function createAllowlist(stage: StageInfo): aws.ssm.Parameter | undefined {
  if (!stage.ownsSharedResources) return undefined;
  return new aws.ssm.Parameter(
    "PrincipalAllowlist",
    {
      name: allowlistParameterName(stage),
      type: "SecureString",
      value: ALLOWLIST_NONE,
      description: `A2H ${stage.name === "prod" ? "prod" : "dev and previews"}: addresses allowed to sign in, comma-separated ("${ALLOWLIST_NONE}" for nobody). Set by the owner; deploys never change it.`,
    },
    { ignoreChanges: ["value"] },
  );
}
