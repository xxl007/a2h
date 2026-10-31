// A test authorization server (m1-hosted-connector task 7.1): an in-process
// HTTP server publishing a JWKS built from `jose` keys, counting how often it
// is fetched, and minting access tokens as Better Auth's `jwt` plugin does
// (signed JWT, `iss`, `aud` = the resource, `sub`, `exp`, space-separated
// `scope`, `azp` = the client id).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";

export const TEST_RESOURCE = "https://mcp.dev.a2h.test/mcp";
export const TEST_CLIENT_ID = "client-claude-code-test";

export interface TestAuthServer {
  /** `http://127.0.0.1:<port>/api/auth` */
  issuer: string;
  jwksUrl: string;
  /** How many times the JWKS was fetched. */
  jwksFetches: () => number;
  /** A signed access token; `claims` override the defaults, `key` signs with another (unpublished) key. */
  mint: (claims?: Record<string, unknown>, options?: { key?: CryptoKey; kid?: string }) => Promise<string>;
  /** A key pair this server never publishes. */
  foreignKey: () => Promise<CryptoKey>;
  stop: () => Promise<void>;
}

export async function startAuthServer(): Promise<TestAuthServer> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA", use: "sig" };
  let fetches = 0;
  const server: Server = createServer((req, res) => {
    if (req.url === "/api/auth/jwks") {
      fetches++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}/api/auth`;
  return {
    issuer,
    jwksUrl: `${issuer}/jwks`,
    jwksFetches: () => fetches,
    async mint(claims = {}, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      const body: Record<string, unknown> = { sub: "user-a", scope: "a2h offline_access", azp: TEST_CLIENT_ID, iss: issuer, aud: TEST_RESOURCE, iat: now, exp: now + 3600, ...claims };
      for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
      return new SignJWT(body).setProtectedHeader({ alg: "EdDSA", kid: options.kid ?? "k1" }).sign(options.key ?? privateKey);
    },
    async foreignKey() {
      return (await generateKeyPair("EdDSA")).privateKey;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A fetch that adds `Authorization: Bearer <token>` (what a signed-in client sends). */
export function withToken(token: string, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return base(input, { ...init, headers });
  };
}
