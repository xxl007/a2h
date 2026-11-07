// S2 Sign in (/sign-in). Better Auth's login page: an agent's connection
// arrives here with its authorization request as a signed query; the link
// in the email resumes it (src/auth/sign-in.ts). A signed-in visitor goes on.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { approvalIdOfPath } from "../../src/approval/link";
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
  // Only an agent's connection ("Sign in to finish connecting your agent")
  // and an approval page ("Sign in to review the question…", m2-approval-page
  // A12; the path only, the token stays in its cookie) are carried in the
  // form; /account/clients is where sign-in leads anyway.
  const approving = next !== undefined && approvalIdOfPath(next) !== undefined;
  const carried = next?.startsWith(AUTHORIZE_PATH) || approving ? next : undefined;
  return (
    <SignInForm
      action={signInAction}
      {...(carried !== undefined ? { next: carried } : {})}
      {...(approving ? { nextPurpose: "approve" as const } : {})}
      {...(stageName !== undefined ? { stageName } : {})}
    />
  );
}
