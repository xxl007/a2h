// The /api/auth route handler as a function of the authorization server,
// and the request it hands over.
//
// Better Auth reads `request.url`. An App Router route handler receives a
// NextRequest, whose `url` is Next's normalised form (NextURL): the first
// loopback literal anywhere in the URL string (`127.0.0.1`, `[::1]`,
// `localhost`) is replaced by `localhost`. On `localhost:3000` that first
// literal is the host itself, so the query is untouched; on a deployed
// stage's host it is the client's `redirect_uri`, and a native client's
// `http://127.0.0.1:<port>/callback` (RFC 8252 §7.3; the test fixtures,
// every MCP CLI client) reaches the authorization endpoint as
// `http://localhost:<port>/callback`, matching nothing it registered:
// `invalid_redirect` on every preview, never locally. The same would rewrite
// the signed `callbackURL` of a magic link. The native Request underneath a
// NextRequest was constructed with the URL as received, so the handler
// rebuilds a plain Request from that one. Nothing else about the request
// changes.
import type { Auth } from "../auth/auth";

/** The URL the request was constructed with, before any subclass's `url` override. */
export function receivedUrl(request: Request): string {
  // The deepest `url` getter on the prototype chain is the platform's.
  let deepest: PropertyDescriptor | undefined;
  for (let proto = Object.getPrototypeOf(request) as object | null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
    const own = Object.getOwnPropertyDescriptor(proto, "url");
    if (own?.get) deepest = own;
  }
  const url: unknown = deepest?.get ? deepest.get.call(request) : request.url;
  return typeof url === "string" ? url : request.url;
}

/** A plain Request on the URL as received; the request itself when nothing rewrote its URL. */
export function asReceived(request: Request): Request {
  const url = receivedUrl(request);
  if (url === request.url) return request;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers,
    body: hasBody ? request.body : null,
    signal: request.signal,
  };
  if (hasBody) init.duplex = "half";
  return new Request(url, init);
}

/** Route handler for every Better Auth path (design D1). */
export function authRouteHandler(getAuth: () => Promise<Auth>): (request: Request) => Promise<Response> {
  return async (request) => {
    const auth = await getAuth();
    return auth.handler(asReceived(request));
  };
}
