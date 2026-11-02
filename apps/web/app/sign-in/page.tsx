// S2 Sign in (/sign-in). Better Auth's login page: an agent's connection
// arrives here with its authorization request as a signed query; the link
// in the email resumes it (src/auth/sign-in.ts). A signed-in visitor goes on.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ROUTES } from "../../src/auth/auth";
import { AUTHORIZE_PATH, authorizeUrlFromLoginQuery, safeNext } from "../../src/auth/sign-in";
import { getRuntime } from "../../src/server/runtime";
import { stageNameFromEnv, toSearchParams } from "../../src/server/stage";
import { signInAction } from "../actions";
import { SignInForm } from "../_ui/forms";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = toSearchParams(await searchParams);
  const next = authorizeUrlFromLoginQuery(query) ?? safeNext(query.get("next"));
  const { auth } = await getRuntime();
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect(next ?? ROUTES.clients);
  const stageName = stageNameFromEnv();
  // Only an agent's connection is carried in the form ("Sign in to finish
  // connecting your agent"); /account/clients is where sign-in leads anyway.
  const connecting = next?.startsWith(AUTHORIZE_PATH) ? next : undefined;
  return (
    <SignInForm
      action={signInAction}
      {...(connecting !== undefined ? { next: connecting } : {})}
      {...(stageName !== undefined ? { stageName } : {})}
    />
  );
}
