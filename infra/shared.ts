// Shared-resource contract between `dev` (publisher) and `pr-*` (readers).
// Parameter names: config.ts SHARED_PARAMETERS, under /a2h/shared/.
import { SHARED_PARAMETERS, sharedParameterName, type SharedKey } from "./config.ts";

export type SharedIds = Record<SharedKey, string>;

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
 * pr-* only: read the identifiers at deploy time. Resolved to plain strings
 * (not Outputs) because Bucket.get takes a string and the email branch needs
 * to know whether a sender exists while the program is being built.
 */
export async function readShared(): Promise<SharedIds> {
  const values = await Promise.all(
    entries.map(async ([key, param]) => {
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
