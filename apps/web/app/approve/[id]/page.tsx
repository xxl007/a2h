// /approve/[id] (m2-approval-page task 5.1, design D7; design.md Screens
// A1-A12). Server-rendered; the question editor is the only client
// behaviour and the page works as a plain form with JavaScript off.
// Order: session (signed out: sign in and come back, A12), then the token
// from the page's cookie, then the principal, then the request's state
// (src/approval/page-data.ts). Nothing here logs the token or a query.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { APPROVAL_COOKIE, approvalPath } from "../../../src/approval/link";
import { loadApprovalPage, type ApprovalPageModel } from "../../../src/approval/page-data";
import { ROUTES } from "../../../src/auth/auth";
import { getRuntime } from "../../../src/server/runtime";
import { stageNameFromEnv } from "../../../src/server/stage";
import { signOutAction } from "../../actions";
import { ApprovalForm } from "../../_ui/approval";
import { approvalAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const path = approvalPath(id);
  const runtime = await getRuntime();
  const h = new Headers();
  (await headers()).forEach((value, key) => h.set(key, value));
  const session = await runtime.auth.api.getSession({ headers: h });
  if (!session) redirect(path ? `${ROUTES.signIn}?next=${encodeURIComponent(path)}` : ROUTES.signIn);

  const model: ApprovalPageModel = path
    ? await loadApprovalPage(runtime.db, {
        requestId: id,
        token: (await cookies()).get(APPROVAL_COOKIE)?.value,
        principalId: session.user.id,
        now: new Date(),
        feeRate: runtime.config.feeRate,
      })
    : { kind: "expired" };
  const stageName = stageNameFromEnv();
  return (
    <ApprovalForm
      model={model}
      action={approvalAction.bind(null, id)}
      email={session.user.email}
      signOutAction={signOutAction}
      {...(stageName !== undefined ? { stageName } : {})}
    />
  );
}
