// Test helper (reusable, m2-org-sign-in tasks 7.1/7.2): the pinned Keycloak
// with the a2h-test realm, started like test/lib/postgres.ts starts Postgres,
// and a scripted browser for its login form. Invented users only.
import { execFileSync } from "node:child_process";

export const KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak:26.8.2@sha256:723b1d6e254c0fc96d5cffec860c7e0744d6a3277822b865bb538cf891575e41";
export const REALM = "a2h-test";
export const CLIENT_ID = "a2h-test";
/** A fixed test value from the realm file, valid only against the local container. */
export const CLIENT_SECRET = "a2h-test-client-secret-not-a-real-secret";
const START = new URL("./start.sh", import.meta.url).pathname;

export const USERS = {
  verified: { username: "verified", password: "test-password-verified", email: "verified.person@a2h-test.example" },
  unverified: { username: "unverified", password: "test-password-unverified", email: "unverified.person@a2h-test.example" },
  noemail: { username: "noemail", password: "test-password-noemail", email: undefined },
  /** Another subject carrying the verified user's address (a reassigned address). */
  reassigned: { username: "reassigned", password: "test-password-reassigned", email: "verified.person@a2h-test.example" },
} as const;
export type TestUser = (typeof USERS)[keyof typeof USERS];

export interface Keycloak {
  url: string;
  issuer: string;
  discoveryUrl: string;
  stop(): void;
}

/** Uses A2H_KEYCLOAK_URL when set (a container started by keycloak/start.sh); else starts one and removes it on stop. */
export function startKeycloak(): Keycloak {
  const given = process.env["A2H_KEYCLOAK_URL"];
  let url = given ?? "";
  let name = "";
  if (!given) {
    const out = execFileSync(START, [], { encoding: "utf8", timeout: 240_000 });
    url = /KEYCLOAK_URL=(\S+)/.exec(out)![1]!;
    name = /KEYCLOAK_CONTAINER=(\S+)/.exec(out)![1]!;
  }
  const issuer = `${url}/realms/${REALM}`;
  return {
    url,
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    stop: () => {
      if (name) execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore" });
    },
  };
}

/** A browser at the provider: keeps Keycloak's cookies (so a second visit is single sign-on). */
export class ProviderBrowser {
  readonly cookies = new Map<string, string>();

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1);
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  /**
   * Opens the authorize URL; types the password when the form is shown.
   * Returns where the provider sends the browser (our callback URL) and
   * whether the form was shown (false: the provider's own session answered).
   */
  async signIn(authorizeUrl: string, user?: TestUser): Promise<{ location: string; formShown: boolean }> {
    const first = await this.fetch(authorizeUrl);
    if (first.status === 302 || first.status === 303) return { location: first.headers.get("location")!, formShown: false };
    const html = await first.text();
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1] ?? /action="([^"]+)"/.exec(html)?.[1];
    if (first.status !== 200 || !action) throw new Error(`keycloak: no login form (status ${first.status}): ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
    if (!user) throw new Error("keycloak: the form was shown and no user was given");
    const posted = await this.fetch(action.replaceAll("&amp;", "&"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: user.username, password: user.password, credentialId: "" }).toString(),
    });
    const location = posted.headers.get("location");
    if (!location) {
      const text = (await posted.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      throw new Error(`keycloak: no redirect after the form (status ${posted.status}): ${text.slice(0, 400)}`);
    }
    return { location, formShown: true };
  }
}
