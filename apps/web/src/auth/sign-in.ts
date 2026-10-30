// Sign-in by magic link (spec principal-identity "Sign-in by magic link to an
// allow-listed address"; design D7, Screens S2/S3). The sign-in server action
// calls `requestMagicLink`; it is the only way to ask for a link (Better
// Auth's HTTP endpoint is disabled in auth.ts).
//
// - An allow-listed address gets one link, valid 15 minutes, single use.
// - Any other address gets exactly the same result, and nothing is created,
//   sent or logged about it.
// - `next` is where the link leads after sign-in: the authorize URL of the
//   agent's connection, or a page of this app. Anything else is dropped (no
//   open redirect).
import * as z from "zod";
import type { Logger } from "../log";
import { AUTH_BASE_PATH } from "../config";
import { ROUTES, type Auth } from "./auth";

export const AUTHORIZE_PATH = `${AUTH_BASE_PATH}/oauth2/authorize`;
/** Parameters Better Auth adds when it sends the browser to the login page (signed query). */
const SIGNED_QUERY_PARAMS = ["sig", "exp", "ba_iat", "ba_pl", "ba_param"];
const LOCAL_PAGES: readonly string[] = [ROUTES.clients];

/**
 * The login page receives the authorization request as a signed query. The
 * link in the email leads back to the authorize endpoint with the original
 * parameters, which then continues to consent with the new session.
 */
export function authorizeUrlFromLoginQuery(query: URLSearchParams): string | undefined {
  if (!query.get("client_id") || !query.get("response_type")) return undefined;
  const params = new URLSearchParams();
  for (const [key, value] of query) {
    if (SIGNED_QUERY_PARAMS.includes(key)) continue;
    if (key === "prompt") {
      // The person has just signed in: `prompt=login` is satisfied.
      const rest = value.split(" ").filter((p) => p && p !== "login");
      if (rest.length) params.append(key, rest.join(" "));
      continue;
    }
    params.append(key, value);
  }
  return `${AUTHORIZE_PATH}?${params.toString()}`;
}

/** `next` as given by a form or a query: an authorize URL or one of this app's pages, relative; else undefined. */
export function safeNext(next: string | null | undefined): string | undefined {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return undefined;
  let url: URL;
  try {
    url = new URL(next, "https://a2h.invalid");
  } catch {
    return undefined;
  }
  if (url.origin !== "https://a2h.invalid") return undefined;
  if (url.pathname === AUTHORIZE_PATH && url.searchParams.get("client_id")) return `${url.pathname}${url.search}`;
  if (LOCAL_PAGES.includes(url.pathname) && !url.search) return url.pathname;
  return undefined;
}

const EmailSchema = z.email();
export const EMAIL_MAX_LENGTH = 254;

export type EmailCheck = { ok: true; email: string } | { ok: false; reason: "empty" | "format" };

export function checkEmail(raw: unknown): EmailCheck {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, reason: "empty" };
  if (value.length > EMAIL_MAX_LENGTH || !EmailSchema.safeParse(value).success) return { ok: false, reason: "format" };
  return { ok: true, email: value };
}

export interface SignInDeps {
  auth: Auth;
  isAllowed: (email: string) => Promise<boolean>;
  logger: Logger;
}

export interface MagicLinkRequest {
  email: string;
  next: string | undefined;
  /** The incoming request's headers (Better Auth needs them for the base URL and the origin check). */
  headers: Headers;
  requestId?: string;
}

/**
 * Sends a link to an allow-listed address; does nothing for any other. The
 * caller shows the same page either way. Throws only on a delivery failure
 * for an allowed address (the "error" state).
 */
export async function requestMagicLink(deps: SignInDeps, req: MagicLinkRequest): Promise<void> {
  const allowed = await deps.isAllowed(req.email);
  const fields = req.requestId ? { request_id: req.requestId } : {};
  if (!allowed) {
    // Same outcome, no row, no email, and no line that could tell the two apart.
    deps.logger.info("magic link requested", { ...fields, code: "magic_link_requested" });
    return;
  }
  const callbackURL = req.next ?? ROUTES.clients;
  const errorCallbackURL = req.next ? `${ROUTES.expired}?next=${encodeURIComponent(req.next)}` : ROUTES.expired;
  await deps.auth.api.signInMagicLink({
    body: { email: req.email, callbackURL, errorCallbackURL },
    headers: req.headers,
  });
  deps.logger.info("magic link requested", { ...fields, code: "magic_link_requested" });
}
