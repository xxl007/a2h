// S3 Check your email (/sign-in/sent). The address comes from the HttpOnly
// flash cookie set by the sign-in action, never from the URL. The page is the
// same for an allow-listed and an unknown address.
import { cookies } from "next/headers";
import { ROUTES } from "../../../src/auth/auth";
import { checkEmail, safeNext } from "../../../src/auth/sign-in";
import { stageNameFromEnv, toSearchParams } from "../../../src/server/stage";
import { resendAction } from "../../actions";
import { FLASH_COOKIE } from "../../flash";
import { CheckEmailForm } from "../../_ui/forms";

export const dynamic = "force-dynamic";

export default async function SentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = toSearchParams(await searchParams);
  const next = safeNext(query.get("next"));
  const flash = (await cookies()).get(FLASH_COOKIE)?.value;
  const checked = flash ? checkEmail(flash) : undefined;
  const email = checked?.ok ? checked.email : undefined;
  const stageName = stageNameFromEnv();
  return (
    <CheckEmailForm
      action={resendAction}
      signInHref={next ? `${ROUTES.signIn}?next=${encodeURIComponent(next)}` : ROUTES.signIn}
      {...(email !== undefined ? { email } : {})}
      {...(next !== undefined ? { next } : {})}
      {...(stageName !== undefined ? { stageName } : {})}
    />
  );
}
