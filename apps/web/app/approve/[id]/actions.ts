"use server";
// Send and Don't send (m2-approval-page task 5.2, design D4). The session is
// the authority: its principal decides, after the allow-list re-check every
// session read runs (src/auth/auth.ts allowlistGate). The token comes from
// the page's HttpOnly cookie (src/approval/link.ts), never from the form.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { decide, type ApprovalActionState } from "../../../src/approval/decide";
import { APPROVAL_COOKIE, approvalPath } from "../../../src/approval/link";
import { ROUTES } from "../../../src/auth/auth";
import { getRuntime } from "../../../src/server/runtime";

function reference(): string {
  return `ref_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export async function approvalAction(requestId: string, _prev: ApprovalActionState, form: FormData): Promise<ApprovalActionState> {
  const path = approvalPath(requestId);
  if (path === undefined) return { state: "expired" };
  const runtime = await getRuntime();
  const h = new Headers();
  (await headers()).forEach((value, key) => h.set(key, value));
  const session = await runtime.auth.api.getSession({ headers: h });
  // Signed out meanwhile (or removed from the allow-list): sign in, then back to the same page.
  if (!session) redirect(`${ROUTES.signIn}?next=${encodeURIComponent(path)}`);
  return decide(
    { db: runtime.db, feeRate: runtime.config.feeRate, logger: runtime.logger },
    { requestId, token: (await cookies()).get(APPROVAL_COOKIE)?.value, principalId: session.user.id, form, reference: reference() },
  );
}
