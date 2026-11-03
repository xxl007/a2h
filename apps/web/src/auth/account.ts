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
  if (removed) logger.info("client revoked", { code: "client_revoked", principal_id: userId, client_id: clientId });
  else logger.info("client already revoked", { code: "client_already_revoked", principal_id: userId, client_id: clientId });
  return removed;
}

/**
 * The Disconnect action of the signed-in principal (scenarios "Client revoked"
 * and "Revoke repeated"). A client that is no longer connected, for example
 * after a revoke in another tab, is a success: the outcome the principal asked
 * for already holds. The revoke is scoped to the session's own principal, so
 * any client id changes nothing of anyone else. Rejects only without a session
 * or when the database call fails.
 */
export async function revokeForSession(
  deps: { db: PrincipalsDb; logger: Logger; userId: string | undefined },
  clientId: string,
): Promise<"revoked" | "already_revoked"> {
  if (deps.userId === undefined) throw new Error("not signed in");
  return (await revokeClient(deps.db, deps.logger, deps.userId, clientId)) ? "revoked" : "already_revoked";
}
