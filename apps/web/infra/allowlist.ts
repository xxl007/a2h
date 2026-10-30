// Deployment adapter for the allow-list (design D7): the SecureString SSM
// parameter named by ALLOWLIST_PARAMETER (`/a2h/shared/principal-allowlist`
// for dev and previews, `/a2h/prod/principal-allowlist` for prod; created by
// the stage deploy, task 8.2). Until the parameter exists, PRINCIPAL_ALLOWLIST
// (a comma-separated list in the environment) is read instead. The value is
// never logged; the Allowlist class (src/auth/allowlist.ts) refreshes it
// every five minutes.
import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";

export interface AllowlistSource {
  parameter: string | undefined;
  fallback: string;
}

export function allowlistLoader(source: AllowlistSource, client: Pick<SSMClient, "send"> | undefined = undefined): () => Promise<string> {
  if (!source.parameter) return () => Promise.resolve(source.fallback);
  const ssm = client ?? new SSMClient({});
  const name = source.parameter;
  return async () => {
    try {
      const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return out.Parameter?.Value ?? "";
    } catch (e) {
      if (e instanceof ParameterNotFound || (e as { name?: string }).name === "ParameterNotFound") return source.fallback;
      throw e;
    }
  };
}
