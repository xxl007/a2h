import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { copy, fill } from "../screens/copy.js";
import { Button } from "./Button.js";
import { isLocalOrigin, originLabel } from "./ClientIdentity.js";
import { Notice } from "./Notice.js";
import type { ClientSummary, DisplayDate } from "./types.js";
import styles from "./ClientRow.module.css";

export type ClientRowState = "idle" | "confirming" | "revoking" | "error";

export interface ConnectedClient extends ClientSummary {
  connectedAt: DisplayDate;
  /** null when the client has not used a token yet; undefined when the server does not track last use (omitted). */
  lastUsedAt?: DisplayDate | null;
}

export interface ClientRowProps {
  client: ConnectedClient;
  /** Revokes the consent and refresh tokens; rejects when it did not go through. */
  onRevoke?: (clientId: string) => Promise<void>;
  /** Called after a successful revoke; the list removes the row and announces it. */
  onRevoked?: (client: ConnectedClient) => void;
  /** Storybook and tests only: start in a given state. */
  initialState?: ClientRowState;
  reference?: string;
}

/**
 * One connected app with an inline confirmation (no browser dialog). Focus moves into the
 * confirmation when it opens, back to "Disconnect" on "Keep connected" or Escape, and to the
 * error notice when revoking fails.
 */
export function ClientRow({ client, onRevoke, onRevoked, initialState = "idle", reference }: ClientRowProps) {
  const c = copy.clients;
  const [state, setState] = useState<ClientRowState>(initialState);
  const [returnFocus, setReturnFocus] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const questionId = useId();
  const origin = originLabel(client.origin);
  const names = { client: client.name, origin };

  useEffect(() => {
    if (state === "confirming" && initialState !== "confirming") confirmRef.current?.focus();
    if (state === "error" && initialState !== "error") errorRef.current?.querySelector<HTMLElement>("[tabindex]")?.focus();
    if (state === "idle" && returnFocus) {
      triggerRef.current?.querySelector("button")?.focus();
      setReturnFocus(false);
    }
  }, [state, initialState, returnFocus]);

  const cancel = () => {
    setState("idle");
    setReturnFocus(true);
  };

  const revoke = async () => {
    setState("revoking");
    try {
      await onRevoke?.(client.id);
      onRevoked?.(client);
    } catch {
      setState("error");
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && state === "confirming") cancel();
  };

  const connected = fill(c.connected, { date: client.connectedAt.label });
  const used =
    client.lastUsedAt === undefined ? undefined : client.lastUsedAt ? fill(c.lastUsed, { date: client.lastUsedAt.label }) : c.neverUsed;
  const dates = used === undefined ? connected : `${connected} · ${used}`;

  return (
    <li className={styles.row}>
      <div className={styles.summary}>
        <div className={styles.who}>
          <h2 className={styles.name}>{client.name}</h2>
          <p className={isLocalOrigin(client.origin) ? styles.local : styles.origin}>{origin}</p>
          <p className={styles.dates}>{dates}</p>
        </div>
        {(state === "idle" || state === "error") && (
          <div ref={triggerRef}>
            <Button variant="ghost" aria-label={fill(c.disconnectLabel, names)} onPress={() => setState("confirming")}>
              {c.disconnect}
            </Button>
          </div>
        )}
      </div>
      {state === "error" && (
        <div ref={errorRef}>
          <Notice
            tone="danger"
            title={fill(c.errorRowTitle, names)}
            live="alert"
            focusable
            {...(reference !== undefined ? { reference } : {})}
          >
            <p>{c.errorRowBody}</p>
          </Notice>
        </div>
      )}
      {(state === "confirming" || state === "revoking") && (
        <div
          ref={confirmRef}
          className={styles.confirm}
          role="group"
          aria-labelledby={questionId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <p id={questionId} className={styles.question}>
            {fill(c.confirmQuestion, names)}
          </p>
          <p className={styles.body}>{c.confirmBody}</p>
          <div className={styles.buttons}>
            <Button isPending={state === "revoking"} pendingLabel={c.confirmPending} onPress={() => void revoke()}>
              {c.confirm}
            </Button>
            <Button variant="ghost" isDisabled={state === "revoking"} onPress={cancel}>
              {c.cancel}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
