// Who may sign in on this stage (design D7): the SSM parameter's value, read
// at cold start and refreshed every five minutes through `load`
// (apps/web/infra/allowlist.ts). Addresses compare lower-cased. A failed
// refresh keeps the last good list; if no list was ever read, nobody is
// allowed (fail closed). Nothing here logs an address.
import type { Logger } from "../log";

export const ALLOWLIST_REFRESH_MS = 5 * 60_000;

/** Comma-, space- or newline-separated addresses; `none` or empty means nobody. */
export function parseAllowlist(value: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const part of value.split(/[\s,]+/)) {
    const address = part.trim().toLowerCase();
    if (address && address !== "none") out.add(address);
  }
  return out;
}

export interface AllowlistOptions {
  refreshMs?: number;
  now?: () => number;
  logger?: Logger;
}

export class Allowlist {
  readonly #load: () => Promise<string>;
  readonly #refreshMs: number;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  #addresses: ReadonlySet<string> | undefined;
  #loadedAt = Number.NEGATIVE_INFINITY;
  #pending: Promise<void> | undefined;

  constructor(load: () => Promise<string>, options: AllowlistOptions = {}) {
    this.#load = load;
    this.#refreshMs = options.refreshMs ?? ALLOWLIST_REFRESH_MS;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  async has(email: string): Promise<boolean> {
    await this.#fresh();
    return this.#addresses?.has(email.trim().toLowerCase()) ?? false;
  }

  async #fresh(): Promise<void> {
    if (this.#addresses && this.#now() - this.#loadedAt <= this.#refreshMs) return;
    this.#pending ??= this.#refresh().finally(() => {
      this.#pending = undefined;
    });
    await this.#pending;
  }

  async #refresh(): Promise<void> {
    try {
      const value = await this.#load();
      this.#addresses = parseAllowlist(value);
      this.#loadedAt = this.#now();
    } catch (e) {
      // Keep the last good list; retry on the next call after a short pause.
      this.#loadedAt = this.#addresses ? this.#now() - this.#refreshMs + 30_000 : Number.NEGATIVE_INFINITY;
      this.#logger?.error("allow-list could not be read", { code: "allowlist_refresh_failed" });
      void e;
    }
  }
}
