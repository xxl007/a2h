// Everything the worker is configured with, as business code sees it. Built
// by the deployment adapter (infra/env.ts) from the environment infra gives
// the worker (infra/service-env.ts); nothing here reads the environment.
import type { Principal, ValidationPolicy } from "@a2h/protocol";
import type { DbConfig } from "./db-config.ts";

/** The stage's platform signing key (design D4): only the worker holds the private half. */
export interface SigningKeyMaterial {
  key_id: string;
  /** PKCS#8 DER of the Ed25519 private key. Never log it. */
  private_key_pkcs8: Uint8Array;
  /** Base64 of the raw 32-byte public key, as stored in `signing_keys`. */
  public_key: string;
}

export interface WorkerConfig {
  stage: string;
  db: DbConfig;
  /** False on prod whatever the environment says (task 5.6). */
  simulatorEnabled: boolean;
  /** The stage's development principal (design D7). */
  principal: Principal;
  /** Its contact policy and the platform fee rate `f` (ADR 0002: configuration, not a constant). */
  policy: ValidationPolicy;
  /** Clearing share `s` (ADR 0002). */
  clearingShare: number;
  signing: SigningKeyMaterial;
}
