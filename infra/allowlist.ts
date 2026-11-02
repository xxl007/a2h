// The allow-list of addresses that may sign in (m1-hosted-connector design
// D7, task 8.2): an SSM SecureString per environment, created by the deploy
// with ALLOWLIST_NONE and then owned by the owner, who sets it with one CLI
// line (docs/runbooks/aws-bootstrap.md). `ignoreChanges: ["value"]`: a later
// deploy never reverts the value. Every stage creates its own (task 8.3
// fact): dev the shared name, prod its own, a preview `/a2h/pr-<n>/…`, which
// the verify job fills with the test addresses and `sst remove` deletes with
// the stage. The web server function reads it (ALLOWLIST_PARAMETER and
// `ssm:GetParameter`, web-env.ts; see infra/README.md).
import { ALLOWLIST_NONE, allowlistParameterName, type StageInfo } from "./config.ts";

export function createAllowlist(stage: StageInfo): aws.ssm.Parameter {
  const who = stage.kind === "pr" ? `preview ${stage.name} (the verify job adds its test addresses; the owner may add theirs)` : stage.kind === "prod" ? "prod (set by the owner)" : "dev (set by the owner)";
  return new aws.ssm.Parameter(
    "PrincipalAllowlist",
    {
      name: allowlistParameterName(stage),
      type: "SecureString",
      value: ALLOWLIST_NONE,
      description: `A2H ${who}: addresses allowed to sign in, comma-separated ("${ALLOWLIST_NONE}" for nobody). Deploys never change it.`,
    },
    { ignoreChanges: ["value"] },
  );
}
