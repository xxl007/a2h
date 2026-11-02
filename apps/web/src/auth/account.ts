// Connected apps (spec principal-identity "Sign-out revokes", scenario
// "Client revoked"; design Screens S5): the clients holding a consent of this
// principal, and revoking one. Revoking deletes the consent and revokes every
// refresh token of that client for this principal in one transaction: the
// client's next refresh fails, access tokens already issued live to their
// own expiry (one hour at most, D1). Nothing else changes: requests the
// principal already approved are not touched.
import { oauthClient, oauthConsent, oauthRefreshToken, type PrincipalsDb, and, desc, eq, isNull } from "@a2h/db";
import type { Logger } from "../log";
import { summarize, type ClientSummary } from "./consent";

export interface ConnectedClientRow extends ClientSummary {
  connectedAt: Date;
}

export async function listConnectedClients(db: PrincipalsDb, userId: string): Promise<ConnectedClientRow[]> {
  const rows = await db
    .select({
      clientId: oauthClient.clientId,
      clientDiscoveryId: oauthClient.clientDiscoveryId,
      metadata: oauthClient.metadata,
      name: oauthClient.name,
      redirectUris: oauthClient.redirectUris,
      connectedAt: oauthConsent.createdAt,
      updatedAt: oauthConsent.updatedAt,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, userId))
    .orderBy(desc(oauthConsent.updatedAt));
  const out: ConnectedClientRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.clientId)) continue;
    seen.add(row.clientId);
    const summary = summarize(row);
    if (summary) out.push({ ...summary, connectedAt: row.connectedAt });
  }
  return out;
}

/** True when a consent existed and was removed. */
export async function revokeClient(db: PrincipalsDb, logger: Logger, userId: string, clientId: string, now: () => Date = () => new Date()): Promise<boolean> {
  const removed = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
      .returning({ id: oauthConsent.id });
    await tx
      .update(oauthRefreshToken)
      .set({ revoked: now() })
      .where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId), isNull(oauthRefreshToken.revoked)));
    return deleted.length > 0;
  });
  logger.info("client revoked", { code: removed ? "client_revoked" : "client_revoke_noop", principal_id: userId, client_id: clientId });
  return removed;
}
