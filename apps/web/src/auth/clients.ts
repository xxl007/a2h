// Pre-registered clients from AUTH_CLIENTS_JSON (design D8): for hosts that
// can use neither a metadata document nor dynamic registration. Written into
// Better Auth's `oauth_client` table at cold start (insert when absent,
// otherwise name, redirect URIs and secret hash brought in line) and linked
// to the stage's MCP resource, marked `pre-registered` so the consent screen
// says "Registered with A2H by the A2H team.". A configured secret is given
// as its base64url SHA-256, the form Better Auth stores and verifies.
import { oauthClient, oauthClientResource, oauthResource, type PrincipalsDb, and, eq } from "@a2h/db";
import type { PreRegisteredClient } from "../config";
import { SCOPES, type Auth } from "./auth";
import { PRE_REGISTERED } from "./consent";

export async function syncPreRegisteredClients(
  db: PrincipalsDb,
  auth: Auth,
  clients: readonly PreRegisteredClient[],
  resource: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (clients.length === 0) return;
  // Better Auth seeds its `oauth_resource` row for the MCP URL when it starts.
  await auth.$context;
  const [seeded] = await db.select({ id: oauthResource.id }).from(oauthResource).where(eq(oauthResource.identifier, resource)).limit(1);
  if (!seeded) throw new Error("the MCP resource is not registered with the authorization server yet");
  for (const c of clients) {
    const values = {
      name: c.client_name,
      redirectUris: c.redirect_uris,
      clientSecret: c.client_secret_sha256 ?? null,
      tokenEndpointAuthMethod: c.client_secret_sha256 ? "client_secret_post" : "none",
      applicationType: c.redirect_uris.every((u) => u.startsWith("https://")) ? "web" : "native",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      scopes: [...SCOPES],
      requirePKCE: true,
      disabled: false,
      metadata: { a2h_registration: PRE_REGISTERED },
      updatedAt: now(),
    };
    await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: oauthClient.id }).from(oauthClient).where(eq(oauthClient.clientId, c.client_id)).limit(1);
      if (existing) await tx.update(oauthClient).set(values).where(eq(oauthClient.id, existing.id));
      else await tx.insert(oauthClient).values({ id: crypto.randomUUID(), clientId: c.client_id, createdAt: now(), ...values });
      const [link] = await tx
        .select({ id: oauthClientResource.id })
        .from(oauthClientResource)
        .where(and(eq(oauthClientResource.clientId, c.client_id), eq(oauthClientResource.resourceId, resource)))
        .limit(1);
      if (!link) await tx.insert(oauthClientResource).values({ id: crypto.randomUUID(), clientId: c.client_id, resourceId: resource, createdAt: now() });
    });
  }
}
