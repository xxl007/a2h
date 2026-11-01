// Better Auth at /api/auth (design D1): magic-link verification, OAuth 2.1
// authorize, token, register, revoke, JWKS. Rendered per request. The
// request is handed over on the URL as received (src/server/auth-route.ts).
import { authRouteHandler } from "../../../../src/server/auth-route";
import { getRuntime } from "../../../../src/server/runtime";

export const dynamic = "force-dynamic";

const handle = authRouteHandler(async () => (await getRuntime()).auth);

export const GET = handle;
export const POST = handle;
