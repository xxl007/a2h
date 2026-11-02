// S4 Consent (/consent): Better Auth's consent page. The signed query names
// the client, the scopes and the redirect; the page shows who asks, how A2H
// knows it, what it may do, for whom, and where the browser returns. An
// expired request and an invalid one have their own screens.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ROUTES } from "../../src/auth/auth";
import { readConsentRequest } from "../../src/auth/consent";
import { getRuntime } from "../../src/server/runtime";
import { stageNameFromEnv, toSearchParams } from "../../src/server/stage";
import { consentAction, signOutAction } from "../actions";
import { ConsentForm } from "../_ui/forms";
import { ConsentRefusedView } from "../_ui/static";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

const load = cache(async (query: string) => {
  const runtime = await getRuntime();
  const session = await runtime.auth.api.getSession({ headers: await headers() });
  const request = await readConsentRequest(runtime.db, runtime.config.secret, new URLSearchParams(query));
  return { session, request };
});

export default async function ConsentPage({ searchParams }: { searchParams: Search }) {
  const query = toSearchParams(await searchParams);
  const { session, request } = await load(query.toString());
  // The authorize step only sends a signed-in browser here; a session that
  // ended since goes through sign-in and back to the same request.
  if (!session) redirect(`${ROUTES.signIn}?${query.toString()}`);
  const stageName = stageNameFromEnv();
  const email = session.user.email;
  if (request.state !== "ready") {
    return <ConsentRefusedView email={email} state={request.state} signOutAction={signOutAction} {...(stageName !== undefined ? { stageName } : {})} />;
  }
  return (
    <ConsentForm
      action={consentAction}
      signOutAction={signOutAction}
      client={request.client}
      scopes={request.scopes}
      returnOrigin={request.returnOrigin}
      email={email}
      oauthQuery={request.oauthQuery}
      {...(stageName !== undefined ? { stageName } : {})}
    />
  );
}
