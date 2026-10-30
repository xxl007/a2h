// Cookie names shared by the server actions and the pages.

/** The address typed on /sign-in, for /sign-in/sent (HttpOnly, path /sign-in, 15 minutes); never in a URL. */
export const FLASH_COOKIE = "a2h_sign_in_address";

/** Better Auth's cookies (`better-auth.*`, `__Secure-better-auth.*` over https). */
export const SESSION_COOKIE_PREFIXES = ["better-auth.", "__Secure-better-auth."];
