import { useEffect, useRef, useState } from "react";
import { ButtonLink } from "../components/Button.js";
import { AuthShell } from "../components/AuthShell.js";
import { ClientRow, type ClientRowState, type ConnectedClient } from "../components/ClientRow.js";
import { Notice } from "../components/Notice.js";
import { Skeleton } from "../components/Skeleton.js";
import type { FormAction } from "../components/types.js";
import { copy, fill } from "./copy.js";
import styles from "./Screen.module.css";

export type ConnectedClientsState = "ready" | "loading" | "error" | "offline";

export interface ConnectedClientsScreenProps {
  email: string;
  clients?: readonly ConnectedClient[];
  state?: ConnectedClientsState;
  onRevoke?: (clientId: string) => Promise<void>;
  signOutAction?: FormAction;
  reference?: string;
  /** Storybook only: open one row in a given state. */
  rowState?: { clientId: string; state: ClientRowState };
  /** Storybook only: show the confirmation of a client already disconnected. */
  initialDisconnected?: string;
  reloadHref?: string;
  stageName?: string;
}

/** /account/clients (design.md "Screen 4: Connected apps"). */
export function ConnectedClientsScreen({
  email,
  clients = [],
  state = "ready",
  onRevoke,
  signOutAction,
  reference,
  rowState,
  initialDisconnected,
  reloadHref = "/account/clients",
  stageName,
}: ConnectedClientsScreenProps) {
  const c = copy.clients;
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const [disconnected, setDisconnected] = useState<string | undefined>(initialDisconnected);
  const doneRef = useRef<HTMLDivElement>(null);
  const visible = clients.filter((client) => !removed.includes(client.id));

  useEffect(() => {
    if (disconnected !== undefined && disconnected !== initialDisconnected) {
      doneRef.current?.querySelector<HTMLElement>("[tabindex]")?.focus();
    }
  }, [disconnected, initialDisconnected]);

  return (
    <AuthShell
      width="wide"
      account={{ email, ...(signOutAction !== undefined ? { signOutAction } : {}) }}
      {...(stageName !== undefined ? { stageName } : {})}
    >
      <h1 className={styles.title}>{c.title}</h1>
      <p className={styles.lead}>{c.lead}</p>
      {disconnected !== undefined && (
        <div ref={doneRef}>
          <Notice tone="success" title={fill(c.doneTitle, { client: disconnected })} live="status" focusable>
            <p>{c.doneBody}</p>
          </Notice>
        </div>
      )}
      {state === "offline" && (
        <Notice tone="neutral" title={c.offlineTitle} live="status">
          <p>{c.offlineBody}</p>
        </Notice>
      )}
      {state === "loading" && (
        <div aria-busy="true" role="status" aria-label={c.loading} className={styles.stack}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.tight}>
              <Skeleton height={20} width="40%" />
              <Skeleton height={16} width="25%" />
              <Skeleton height={16} width="60%" />
            </div>
          ))}
        </div>
      )}
      {state === "error" && (
        <>
          <Notice tone="danger" title={c.errorTitle} live="alert" {...(reference !== undefined ? { reference } : {})}>
            <p>{c.errorBody}</p>
          </Notice>
          <div className={styles.actions}>
            <ButtonLink href={reloadHref} variant="ghost">
              {c.reload}
            </ButtonLink>
          </div>
        </>
      )}
      {(state === "ready" || state === "offline") && visible.length === 0 && (
        <Notice tone="neutral" title={c.emptyTitle}>
          <p>{c.emptyBody}</p>
        </Notice>
      )}
      {(state === "ready" || state === "offline") && visible.length > 0 && (
        <ul className={styles.list} aria-label={c.title}>
          {visible.map((client) => (
            <ClientRow
              key={client.id}
              client={client}
              {...(onRevoke !== undefined ? { onRevoke } : {})}
              onRevoked={(gone) => {
                setRemoved((ids) => [...ids, gone.id]);
                setDisconnected(gone.name);
              }}
              {...(rowState?.clientId === client.id ? { initialState: rowState.state } : {})}
              {...(reference !== undefined ? { reference } : {})}
            />
          ))}
        </ul>
      )}
    </AuthShell>
  );
}
