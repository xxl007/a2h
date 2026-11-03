// The approval link's token on the web side (m2-approval-page design D2, D7;
// design.md A12). The link is /approve/{id}?t={token}. The first hit moves
// the token into an HttpOnly cookie scoped to that one page and continues at
// the bare /approve/{id}, so the token never sits in the address bar, the
// history, a Referer, the sign-in `next`, the magic-link email or a log; the
// page and its server action read it back from the cookie. The token alone
// grants nothing: the page also requires the request's principal.
import { REQUEST_ID_PATTERN } from "@a2h/protocol";

export const APPROVAL_COOKIE = "a2h_approval";
/** A link lives at most 24 hours (protocol APPROVAL_LINK_MAX_SECONDS); the cookie no longer. */
export const APPROVAL_COOKIE_SECONDS = 24 * 3600;

const PATH = /^\/approve\/([^/]+)$/;

/** `/approve/{id}` for a well-formed request id, else undefined. */
export function approvalPath(requestId: string): string | undefined {
  return REQUEST_ID_PATTERN.test(requestId) ? `/approve/${requestId}` : undefined;
}

/** The request id of an approval page path, else undefined. */
export function approvalIdOfPath(pathname: string): string | undefined {
  const m = PATH.exec(pathname);
  return m && REQUEST_ID_PATTERN.test(m[1]!) ? m[1] : undefined;
}

export interface TokenCookie {
  name: string;
  value: string;
  path: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  maxAge: number;
}

/** For /approve/{id}?t=…: where to continue and the cookie to set. Undefined when there is nothing to move. */
export function approvalTokenRedirect(url: URL): { location: string; cookie: TokenCookie } | undefined {
  const id = approvalIdOfPath(url.pathname);
  const token = url.searchParams.get("t");
  if (id === undefined || token === null) return undefined;
  const path = `/approve/${id}`;
  return {
    location: `${url.origin}${path}`,
    cookie: {
      name: APPROVAL_COOKIE,
      // Bounded: anything longer than a token is no token (the page shows the expired link).
      value: token.slice(0, 64),
      path,
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "lax",
      maxAge: APPROVAL_COOKIE_SECONDS,
    },
  };
}
