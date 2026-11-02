import { useId } from "react";
import type { ClientSummary } from "./types.js";
import styles from "./ClientIdentity.module.css";

export const LOCAL_ORIGIN_LABEL = "a program on this computer";

export function isLocalOrigin(origin: string): boolean {
  return origin === "localhost" || origin === "127.0.0.1" || origin === "[::1]" || origin === "::1";
}

export function originLabel(origin: string): string {
  return isLocalOrigin(origin) ? LOCAL_ORIGIN_LABEL : origin;
}

export function provenanceText(client: ClientSummary): string {
  switch (client.registration) {
    case "metadata-document":
      return `Name published by ${originLabel(client.origin)}.`;
    case "pre-registered":
      return "Registered with A2H by the A2H team.";
    case "dynamic":
      return "This app registered itself. A2H has not checked its name. Continue only if you started this connection.";
  }
}

export interface ClientIdentityProps {
  client: ClientSummary;
  /** Heading level of the name inside the page outline. */
  headingLevel?: 2 | 3;
}

/**
 * Machine-origin block: the client's self-declared name in the accent role, the host it is
 * identified by in the mono role, and how A2H knows it, in words (skill §3, §6).
 */
export function ClientIdentity({ client, headingLevel = 2 }: ClientIdentityProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const eyebrowId = useId();
  const nameId = useId();
  return (
    <section className={styles.identity} aria-labelledby={`${eyebrowId} ${nameId}`}>
      <p id={eyebrowId} className={styles.eyebrow}>
        App asking to connect
      </p>
      <Heading id={nameId} className={styles.name}>
        {client.name}
      </Heading>
      <p className={isLocalOrigin(client.origin) ? styles.local : styles.origin}>{originLabel(client.origin)}</p>
      <p className={`${styles.provenance} ${client.registration === "dynamic" ? styles.unverified : ""}`}>
        {provenanceText(client)}
      </p>
    </section>
  );
}
