// S3b Link no longer works (/sign-in/expired): the magic-link verify
// endpoint's errorCallbackURL for an expired or already used link. One
// message for both; no session was created.
import { ROUTES } from "../../../src/auth/auth";
import { safeNext } from "../../../src/auth/sign-in";
import { stageNameFromEnv, toSearchParams } from "../../../src/server/stage";
import { ExpiredView } from "../../_ui/static";

export const dynamic = "force-dynamic";

export default async function ExpiredPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeNext(toSearchParams(await searchParams).get("next"));
  const stageName = stageNameFromEnv();
  return (
    <ExpiredView
      signInHref={next ? `${ROUTES.signIn}?next=${encodeURIComponent(next)}` : ROUTES.signIn}
      {...(stageName !== undefined ? { stageName } : {})}
    />
  );
}
