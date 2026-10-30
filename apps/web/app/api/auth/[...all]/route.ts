// Better Auth at /api/auth (design D1): magic-link verification, OAuth 2.1
// authorize, token, register, revoke, JWKS. Rendered per request.
import { getRuntime } from "../../../../src/server/runtime";

export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const { auth } = await getRuntime();
  return auth.handler(request);
}

export const GET = handle;
export const POST = handle;
