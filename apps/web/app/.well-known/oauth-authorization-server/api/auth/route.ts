// RFC 8414 metadata for the issuer `https://<web host>/api/auth`, at the
// path-aware well-known URL (design D8). No OpenID configuration: the server
// is OAuth-only (scopes `a2h`, `offline_access`).
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getRuntime } from "../../../../../src/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { auth } = await getRuntime();
  return oauthProviderAuthServerMetadata(auth)(request);
}
