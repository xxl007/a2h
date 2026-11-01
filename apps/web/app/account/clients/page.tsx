// S5 Connected apps (/account/clients): the clients holding a consent of the
// signed-in principal, newest first, with an inline disconnect.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ConnectedClient } from "@a2h/ui";
import { listConnectedClients } from "../../../src/auth/account";
import { ROUTES } from "../../../src/auth/auth";
import { getRuntime } from "../../../src/server/runtime";
import { stageNameFromEnv } from "../../../src/server/stage";
import { revokeAction, signOutAction } from "../../actions";
import { ConnectedClientsView } from "../../_ui/forms";

export const dynamic = "force-dynamic";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default async function ConnectedAppsPage() {
  const runtime = await getRuntime();
  const session = await runtime.auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`${ROUTES.signIn}?next=${encodeURIComponent(ROUTES.clients)}`);
  const stageName = stageNameFromEnv();
  let clients: ConnectedClient[] = [];
  let state: "ready" | "error" = "ready";
  let reference: string | undefined;
  try {
    // "Last used" is not recorded per client by Better Auth: omitted (design.md open question 4).
    clients = (await listConnectedClients(runtime.db, session.user.id)).map((c) => ({
      id: c.id,
      name: c.name,
      origin: c.origin,
      registration: c.registration,
      connectedAt: { iso: c.connectedAt.toISOString(), label: DATE.format(c.connectedAt) },
    }));
  } catch (e) {
    state = "error";
    reference = `ref_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    runtime.logger.error("connected apps not read", { code: e instanceof Error ? e.name : "error", request_id: reference, principal_id: session.user.id });
  }
  return (
    <ConnectedClientsView
      email={session.user.email}
      clients={clients}
      state={state}
      onRevoke={revokeAction}
      signOutAction={signOutAction}
      {...(reference !== undefined ? { reference } : {})}
      {...(stageName !== undefined ? { stageName } : {})}
    />
  );
}
