// S6 Signed out (/signed-out): the session is revoked; apps stay connected.
import { stageNameFromEnv } from "../../src/server/stage";
import { SignedOutView } from "../_ui/static";

export const dynamic = "force-dynamic";

export default function SignedOutPage() {
  const stageName = stageNameFromEnv();
  return <SignedOutView {...(stageName !== undefined ? { stageName } : {})} />;
}
