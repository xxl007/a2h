// Shared-resource contract between `dev` (publisher) and `pr-*` (readers).
// Parameter names: config.ts SHARED_PARAMETERS, under /a2h/shared/.
import {
  PR_STAGE_READS,
  SHARED_PARAMETERS,
  sharedParameterName,
  type SharedKey,
} from "./config.ts";

type PrReadKey = (typeof PR_STAGE_READS)[number];
export type SharedIds = Record<PrReadKey, string>;

const entries = Object.entries(SHARED_PARAMETERS) as [SharedKey, string][];

/** dev only: publish the identifiers of the shared resources as SSM String parameters. */
export function publishShared(values: Record<SharedKey, $util.Input<string>>) {
  for (const [key, param] of entries) {
    new aws.ssm.Parameter(`Shared${key[0]!.toUpperCase()}${key.slice(1)}`, {
      name: sharedParameterName(param),
      type: "String",
      value: values[key],
      description: `A2H shared resource (${param}) published by the dev stage for pr-* stages.`,
    });
  }
}

/**
 * pr-* only: read the identifiers it uses (PR_STAGE_READS) at deploy time.
 * Resolved to plain strings (not Outputs) because the scoped storage ARNs and
 * the email branch are decided while the program is being built.
 */
export async function readShared(): Promise<SharedIds> {
  // Only PR_STAGE_READS: never the Aurora secret ARN (contract amendment 1).
  const values = await Promise.all(
    PR_STAGE_READS.map(async (key) => {
      const param = SHARED_PARAMETERS[key];
      const name = sharedParameterName(param);
      try {
        const parameter = await aws.ssm.getParameter({ name });
        return [key, parameter.value] as const;
      } catch (cause) {
        throw new Error(
          `SSM parameter ${name} is missing or unreadable. Deploy the dev stage first (docs/runbooks/aws-bootstrap.md).`,
          { cause },
        );
      }
    }),
  );
  return Object.fromEntries(values) as SharedIds;
}
