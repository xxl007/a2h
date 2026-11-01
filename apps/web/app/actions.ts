"use server";
// Server actions of the sign-in, consent and connected-apps screens
// (design.md Screens; spec principal-identity). Every action logs ids and
// codes only; the address never leaves the request except into the HttpOnly
// flash cookie that /sign-in/sent reads (never the URL).
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { listConnectedClients, revokeClient } from "../src/auth/account";
import { ROUTES } from "../src/auth/auth";
import { ConsentError, decideConsent } from "../src/auth/consent";
import { checkEmail, requestMagicLink, safeNext } from "../src/auth/sign-in";
import { getRuntime } from "../src/server/runtime";
import { FLASH_COOKIE, SESSION_COOKIE_PREFIXES } from "./flash";

async function requestHeaders(): Promise<Headers> {
  const h = new Headers();
  (await headers()).forEach((value, key) => h.set(key, value));
  return h;
}

function reference(): string {
  return `ref_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export interface SignInActionState {
  state: "idle" | "invalid" | "error";
  email?: string;
  invalidReason?: "empty" | "format";
  reference?: string;
}

async function setFlash(email: string, secure: boolean): Promise<void> {
  (await cookies()).set(FLASH_COOKIE, email, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: ROUTES.signIn,
    maxAge: 15 * 60,
  });
}

/** /sign-in form: same outcome for every valid address (spec "Unknown address"). */
export async function signInAction(_prev: SignInActionState, form: FormData): Promise<SignInActionState> {
  const typed = typeof form.get("email") === "string" ? (form.get("email") as string) : "";
  const check = checkEmail(typed);
  if (!check.ok) return { state: "invalid", email: typed, invalidReason: check.reason };
  const next = safeNext(form.get("next") as string | null);
  const ref = reference();
  const runtime = await getRuntime();
  try {
    await requestMagicLink(
      { auth: runtime.auth, isAllowed: runtime.isAllowed, logger: runtime.logger },
      { email: check.email, next, headers: await requestHeaders(), requestId: ref },
    );
  } catch (e) {
    runtime.logger.error("magic link not sent", { code: e instanceof Error ? e.name : "error", request_id: ref });
    return { state: "error", email: check.email, reference: ref };
  }
  await setFlash(check.email, runtime.config.baseURL.startsWith("https://"));
  redirect(next ? `${ROUTES.sent}?next=${encodeURIComponent(next)}` : ROUTES.sent);
}

export interface ResendActionState {
  state: "sent" | "resent" | "error";
  reference?: string;
}

/** /sign-in/sent "Send another link": the address comes from the hidden field the page filled from the flash cookie. */
export async function resendAction(_prev: ResendActionState, form: FormData): Promise<ResendActionState> {
  const check = checkEmail(form.get("email"));
  const next = safeNext(form.get("next") as string | null);
  const ref = reference();
  const runtime = await getRuntime();
  if (!check.ok) {
    // Without an address (cookie expired) there is nothing to resend: back to the form.
    redirect(next ? `${ROUTES.signIn}?next=${encodeURIComponent(next)}` : ROUTES.signIn);
  }
  try {
    await requestMagicLink(
      { auth: runtime.auth, isAllowed: runtime.isAllowed, logger: runtime.logger },
      { email: check.email, next, headers: await requestHeaders(), requestId: ref },
    );
  } catch (e) {
    runtime.logger.error("magic link not sent", { code: e instanceof Error ? e.name : "error", request_id: ref });
    return { state: "error", reference: ref };
  }
  await setFlash(check.email, runtime.config.baseURL.startsWith("https://"));
  return { state: "resent" };
}

export interface ConsentActionState {
  state: "ready" | "error" | "expired";
  reference?: string;
}

/** /consent: accept or decline; the browser then goes back to the client. */
export async function consentAction(_prev: ConsentActionState, form: FormData): Promise<ConsentActionState> {
  const runtime = await getRuntime();
  const h = await requestHeaders();
  const session = await runtime.auth.api.getSession({ headers: h });
  const oauthQuery = form.get("oauth_query");
  if (!session || typeof oauthQuery !== "string") return { state: "expired" };
  const ref = reference();
  let url: string;
  try {
    url = await decideConsent(
      { db: runtime.db, baseURL: runtime.config.baseURL, authOn: runtime.authOn, defaultPolicy: runtime.config.defaultPolicy, logger: runtime.logger },
      { accept: form.get("accept") === "true", oauthQuery, userId: session.user.id, headers: h, requestId: ref },
    );
  } catch (e) {
    if (e instanceof ConsentError && e.status < 500) return { state: "expired" };
    runtime.logger.error("consent not recorded", { code: e instanceof Error ? e.name : "error", request_id: ref, principal_id: session.user.id });
    return { state: "error", reference: ref };
  }
  redirect(url);
}

/** Connected apps: revoke one client (spec "Client revoked"). Rejects when it did not go through. */
export async function revokeAction(clientId: string): Promise<void> {
  const runtime = await getRuntime();
  const session = await runtime.auth.api.getSession({ headers: await requestHeaders() });
  if (!session) throw new Error("not signed in");
  const mine = await listConnectedClients(runtime.db, session.user.id);
  if (!mine.some((c) => c.id === clientId)) throw new Error("not connected");
  await revokeClient(runtime.db, runtime.logger, session.user.id, clientId);
}

/** Header "Sign out": the session is revoked; consents held by apps stay (S6). */
export async function signOutAction(): Promise<void> {
  const runtime = await getRuntime();
  const h = await requestHeaders();
  try {
    await runtime.auth.api.signOut({ headers: h });
  } catch {
    // No session: already signed out.
  }
  const jar = await cookies();
  for (const c of jar.getAll()) {
    if (SESSION_COOKIE_PREFIXES.some((p) => c.name.startsWith(p))) jar.delete(c.name);
  }
  runtime.logger.info("signed out", { code: "signed_out" });
  redirect(ROUTES.signedOut);
}
