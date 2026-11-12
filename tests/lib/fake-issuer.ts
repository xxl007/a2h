// A small OpenID Connect issuer for sign-in tests (m2-org-sign-in task 7.1,
// design D10). It starts in the test process on a loopback port and plays the
// organisation's identity provider: discovery document, JWKS, an authorization
// endpoint that redirects back at once with a code for the person the test
// chose, a token endpoint that checks the client, the code and PKCE and returns
// a signed ID token with the nonce echoed, and a userinfo endpoint.
//
//   const idp = await startFakeIssuer({ clientId, clientSecret, redirectUris });
//   idp.signInAs(PEOPLE.alpha);                    // the next sign-ins succeed as alpha
//   idp.signInAs(PEOPLE.alpha, "wrong_audience");  // ... or carry exactly one fault
//   await idp.outage("refused" | "hang");          // the provider cannot be reached
//   await idp.reset();                             // between tests
//   await idp.close();
//
// Each fault changes one thing and leaves the rest of the answer good, so a
// test that is refused under a fault is refused for that reason
// (fake-issuer.test.ts proves it by verifying the tokens with jose).
//
// This file imports only Node and jose (pinned to the same version in
// apps/web and here) and no sibling file, so apps/web tests import it by
// relative path as tests/ already imports apps/*/test/lib: one copy.
//
// Signing keys are generated at start and live in memory only. The people are
// invented, on a reserved domain (RFC 2606 `.example`): no mailbox can exist.
// Nothing here logs; `requests` keeps method and path only, never a query.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface TestPerson {
  /** The provider's subject identifier. */
  sub: string;
  email: string;
  name: string;
  /** What the provider asserts about the address. Default true; "true" is the string form Google's documentation shows. */
  emailVerified?: boolean | string;
}

const DOMAIN = "a2h-fake-idp.example";

/** Invented people. alpha and bravo for two accounts (person and administrator flows), charlie as a spare. */
export const PEOPLE = {
  alpha: { sub: "fake-idp-sub-alpha", email: `alpha@${DOMAIN}`, name: "Alpha Testperson" },
  bravo: { sub: "fake-idp-sub-bravo", email: `bravo@${DOMAIN}`, name: "Bravo Testperson" },
  charlie: { sub: "fake-idp-sub-charlie", email: `charlie@${DOMAIN}`, name: "Charlie Testperson" },
} as const satisfies Record<string, TestPerson>;

/** Scenario "Never matched by email address alone": a subject never seen before, carrying this person's address. */
export function sameEmailNewSubject(person: TestPerson): TestPerson {
  return { ...person, sub: `${person.sub}-other-${randomBytes(6).toString("hex")}` };
}

/** Scenario "Returning person is recognised by the provider's identifier": the same subject, another address. */
export function withChangedEmail(person: TestPerson, email: string): TestPerson {
  return { ...person, email };
}

/**
 * One fault per refusal of the spec delta `platform/principal-identity`.
 *
 * Scenario "Email address not verified":
 * - `no_email`: no address and no verified claim, in the ID token and in userinfo.
 * - `email_unverified`: the address, with the verified claim false.
 * - `no_verified_claim`: the address, with no verified claim at all.
 *
 * Scenario "Answer not meant for this install" (the ID token; everything else in it is good):
 * - `wrong_issuer`: `iss` is another issuer.
 * - `wrong_audience`: `aud` is another client.
 * - `expired`: `exp` is an hour in the past.
 * - `wrong_key`: signed by a key that is not in the JWKS, under the published key id.
 * - `wrong_nonce`: `nonce` is not the one of the authorization request.
 * - `wrong_state`: the callback carries a code with a state the relying party did not send.
 *
 * Scenario "Person cancels or the provider refuses" (the callback gets an error and no code):
 * - `cancelled`: `error=access_denied`.
 * - `provider_error`: `error=server_error`.
 *
 * "Provider cannot be reached" is not a fault of one sign-in: see `outage`.
 * The people cases are `sameEmailNewSubject` and `withChangedEmail`.
 */
export const FAULTS = [
  "no_email",
  "email_unverified",
  "no_verified_claim",
  "wrong_issuer",
  "wrong_audience",
  "expired",
  "wrong_key",
  "wrong_nonce",
  "wrong_state",
  "cancelled",
  "provider_error",
] as const;
export type Fault = (typeof FAULTS)[number];

/** The faults that live in the ID token, usable with `mintIdToken` too. */
export type TokenFault = Exclude<Fault, "wrong_state" | "cancelled" | "provider_error">;

export interface FakeIssuerOptions {
  /** The client this install is registered as. */
  clientId: string;
  clientSecret: string;
  /** Exact redirect addresses registered for the client, e.g. `http://localhost:3000/api/auth/callback/idp`. Omitted: any is accepted. */
  redirectUris?: string[];
  /** The claim that carries the provider's assertion about the address. Default `email_verified`; `xms_edov` for Microsoft Entra ID. */
  emailVerifiedClaim?: string;
  /** Fixed port; default: any free one. */
  port?: number;
  /** The issuer's clock, for `iat` and `exp`. Default: the system clock. */
  now?: () => Date;
}

export interface IssuedSignIn {
  person: TestPerson;
  fault: Fault | undefined;
  /** Kept so a test can prove that neither token reached a log line or a database row. */
  idToken: string;
  accessToken: string;
}

export interface SeenRequest {
  method: string;
  /** Path only: a query can carry a code or a state. */
  path: string;
}

export interface FakeIssuer {
  /** `http://127.0.0.1:<port>`, the `iss` of every good token. */
  readonly issuer: string;
  /** What the install is configured with (`IDP_DISCOVERY_URL`). */
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Public half of the key `wrong_key` signs with; it is never in the JWKS. */
  readonly otherKey: JWK;
  /** Every request received since the last reset, in order (also those held or made during a "hang"). */
  readonly requests: readonly SeenRequest[];
  /** Every sign-in that reached the token endpoint successfully since the last reset. */
  readonly issued: readonly IssuedSignIn[];
  /** The last redirect the authorization endpoint answered with, for replaying a callback. */
  readonly lastCallback: string | undefined;
  /** Who the authorization endpoint signs in from now on, and with which fault. Holds until changed or reset. */
  signInAs(person: TestPerson, fault?: Fault): void;
  /** The browser's part without a browser: GET an authorization URL of this issuer and return the redirect back to the relying party. */
  authorize(authorizationUrl: string): Promise<URL>;
  /** An ID token outside any flow (for posting a raw token to an endpoint that must refuse it). Not recorded in `issued`. */
  mintIdToken(person: TestPerson, options?: { nonce?: string; fault?: TokenFault }): Promise<string>;
  /** "refused": nothing listens on the port. "hang": connections are accepted and never answered (callers need their own timeout). */
  outage(kind: "refused" | "hang"): Promise<void>;
  /** End an outage: same port, same keys. Requests held by a "hang" are dropped. */
  recover(): Promise<void>;
  /** Between tests: ends an outage and forgets the selection, the records, the codes and the access tokens. Keys and port stay. */
  reset(): Promise<void>;
  /** Stop for good. */
  close(): Promise<void>;
}

const ALG = "RS256";
const LIFETIME_SECONDS = 300;
const HOST = "127.0.0.1";
const OTHER_ISSUER = `https://another-issuer.${DOMAIN}`;
const OTHER_AUDIENCE = "another-client";

interface Grant {
  person: TestPerson;
  fault: Fault | undefined;
  nonce: string | undefined;
  challenge: string;
  redirectUri: string;
  scope: string;
}

function same(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 16_384) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

export async function startFakeIssuer(options: FakeIssuerOptions): Promise<FakeIssuer> {
  const now = options.now ?? (() => new Date());
  const verifiedClaim = options.emailVerifiedClaim ?? "email_verified";

  // Two keys, made here and never written anywhere: the issuer's, and the one
  // `wrong_key` signs with under the issuer's key id.
  const [signing, other] = await Promise.all([generateKeyPair(ALG), generateKeyPair(ALG)]);
  const publicJwk = await exportJWK(signing.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  const jwks = { keys: [{ ...publicJwk, kid, use: "sig", alg: ALG }] };
  const otherKey: JWK = { ...(await exportJWK(other.publicKey)), kid, use: "sig", alg: ALG };

  let selected: { person: TestPerson; fault: Fault | undefined } | undefined;
  let requests: SeenRequest[] = [];
  let issued: IssuedSignIn[] = [];
  let lastCallback: string | undefined;
  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, Record<string, unknown>>();

  let hanging = false;
  let listening = false;
  let closed = false;
  const held = new Set<Socket>();

  /** The person as the provider describes them, in the ID token and at userinfo alike. */
  function personClaims(person: TestPerson, fault: Fault | undefined): Record<string, unknown> {
    const claims: Record<string, unknown> = { sub: person.sub, name: person.name };
    if (fault === "no_email") return claims;
    claims.email = person.email;
    if (fault === "no_verified_claim") return claims;
    claims[verifiedClaim] = fault === "email_unverified" ? false : (person.emailVerified ?? true);
    return claims;
  }

  async function idToken(person: TestPerson, fault: Fault | undefined, nonce: string | undefined): Promise<string> {
    const at = Math.floor(now().getTime() / 1000);
    // Expired: issued 65 minutes ago for 5 minutes, so an hour past and beyond any clock tolerance.
    const iat = fault === "expired" ? at - 3600 - LIFETIME_SECONDS : at;
    const sentNonce = fault === "wrong_nonce" ? `not-your-nonce-${randomBytes(8).toString("hex")}` : nonce;
    return new SignJWT({
      ...personClaims(person, fault),
      auth_time: iat,
      ...(sentNonce === undefined ? {} : { nonce: sentNonce }),
    })
      .setProtectedHeader({ alg: ALG, kid, typ: "JWT" })
      .setIssuer(fault === "wrong_issuer" ? OTHER_ISSUER : issuer)
      .setAudience(fault === "wrong_audience" ? OTHER_AUDIENCE : options.clientId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + LIFETIME_SECONDS)
      .sign(fault === "wrong_key" ? other.privateKey : signing.privateKey);
  }

  function authorizeEndpoint(url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    const redirectUri = q.get("redirect_uri");
    // Client and redirect address first: with either wrong, a provider shows a page and redirects nowhere.
    if (q.get("client_id") !== options.clientId) return text(res, 400, "fake issuer: unknown client_id");
    if (!redirectUri || (options.redirectUris && !options.redirectUris.includes(redirectUri))) {
      return text(res, 400, "fake issuer: redirect_uri is not registered for this client");
    }
    const state = q.get("state");
    const back = (params: Record<string, string>, sentState: string | null = state): void => {
      const target = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
      if (sentState !== null) target.searchParams.set("state", sentState);
      lastCallback = target.toString();
      res.writeHead(302, { location: lastCallback, "cache-control": "no-store" });
      res.end();
    };
    if (q.get("response_type") !== "code") return back({ error: "unsupported_response_type" });
    const scope = q.get("scope") ?? "";
    if (!scope.split(" ").includes("openid")) return back({ error: "invalid_scope" });
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256") {
      return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
    }
    if (!selected) return text(res, 500, "fake issuer: no person selected; call signInAs(person) before starting a sign-in");
    const { person, fault } = selected;
    if (fault === "cancelled") return back({ error: "access_denied" });
    if (fault === "provider_error") return back({ error: "server_error" });
    const code = randomBytes(24).toString("base64url");
    grants.set(code, { person, fault, nonce: q.get("nonce") ?? undefined, challenge, redirectUri, scope });
    back({ code }, fault === "wrong_state" ? `not-your-state-${randomBytes(8).toString("hex")}` : state);
  }

  async function tokenEndpoint(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(req));
    // Client authentication: client_secret_basic or client_secret_post.
    let clientId = form.get("client_id");
    let clientSecret = form.get("client_secret");
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      clientId = decodeURIComponent(decoded.slice(0, Math.max(colon, 0)));
      clientSecret = decodeURIComponent(decoded.slice(colon + 1));
    }
    if (clientId !== options.clientId || clientSecret === null || !same(clientSecret, options.clientSecret)) {
      return json(res, 401, { error: "invalid_client" }, { "www-authenticate": 'Basic realm="fake-issuer"' });
    }
    if (form.get("grant_type") !== "authorization_code") return json(res, 400, { error: "unsupported_grant_type" });
    const code = form.get("code") ?? "";
    const grant = grants.get(code);
    // Single use: a code presented by the client is spent, whatever follows.
    grants.delete(code);
    if (!grant) return json(res, 400, { error: "invalid_grant", error_description: "unknown or used code" });
    if (form.get("redirect_uri") !== grant.redirectUri) return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
    const verifier = form.get("code_verifier");
    if (!verifier || !same(createHash("sha256").update(verifier).digest("base64url"), grant.challenge)) {
      return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    }
    const accessToken = randomBytes(24).toString("base64url");
    accessTokens.set(accessToken, personClaims(grant.person, grant.fault));
    const token = await idToken(grant.person, grant.fault, grant.nonce);
    issued.push({ person: grant.person, fault: grant.fault, idToken: token, accessToken });
    json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: LIFETIME_SECONDS, id_token: token, scope: grant.scope });
  }

  function userinfoEndpoint(req: IncomingMessage, res: ServerResponse): void {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "");
    const claims = bearer ? accessTokens.get(bearer[1]!) : undefined;
    if (!claims) return json(res, 401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
    json(res, 200, claims);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", issuer);
    const method = req.method ?? "GET";
    requests.push({ method, path: url.pathname });
    // One connection per request: a client that pooled a connection would
    // find it dead after an outage and fail once with a socket error instead
    // of "connection refused", or after recover() instead of succeeding.
    res.setHeader("connection", "close");
    if (hanging) {
      // Accepted, never answered. The socket is dropped at recover() or close().
      const socket = req.socket;
      held.add(socket);
      socket.once("close", () => held.delete(socket));
      return;
    }
    const route = `${method} ${url.pathname}`;
    if (route === "GET /.well-known/openid-configuration") {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: [ALG],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        scopes_supported: ["openid", "email", "profile"],
        claims_supported: ["iss", "sub", "aud", "exp", "iat", "auth_time", "nonce", "email", verifiedClaim, "name"],
      });
    }
    if (route === "GET /jwks") return json(res, 200, jwks);
    if (route === "GET /authorize") return authorizeEndpoint(url, res);
    if (route === "POST /token") return tokenEndpoint(req, res);
    if (route === "GET /userinfo") return userinfoEndpoint(req, res);
    text(res, 404, "fake issuer: no such endpoint");
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) text(res, 500, "fake issuer: internal error");
      else res.destroy();
    });
  });

  function listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      server.once("error", failed);
      server.listen(port, HOST, () => {
        server.off("error", failed);
        listening = true;
        resolve();
      });
    });
  }

  function stopListening(): Promise<void> {
    if (!listening) return Promise.resolve();
    listening = false;
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }

  function dropHeld(): void {
    hanging = false;
    for (const socket of held) socket.destroy();
    held.clear();
  }

  await listen(options.port ?? 0);
  const port = (server.address() as AddressInfo).port;
  const issuer = `http://${HOST}:${port}`;

  async function recover(): Promise<void> {
    if (closed) throw new Error("fake issuer: closed");
    dropHeld();
    // The same port, so the issuer and every URL already handed out stay true.
    if (!listening) await listen(port);
  }

  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    otherKey,
    get requests() {
      return requests;
    },
    get issued() {
      return issued;
    },
    get lastCallback() {
      return lastCallback;
    },
    signInAs(person, fault) {
      selected = { person, fault };
    },
    async authorize(authorizationUrl) {
      if (!authorizationUrl.startsWith(`${issuer}/authorize?`)) throw new Error("fake issuer: not this issuer's authorization endpoint");
      const res = await fetch(authorizationUrl, { redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status !== 302 || !location) throw new Error(`fake issuer: the authorization endpoint answered ${res.status}: ${await res.text()}`);
      return new URL(location);
    },
    mintIdToken(person, minted = {}) {
      return idToken(person, minted.fault, minted.nonce);
    },
    async outage(kind) {
      if (closed) throw new Error("fake issuer: closed");
      await recover();
      if (kind === "hang") hanging = true;
      else await stopListening();
    },
    recover,
    async reset() {
      await recover();
      selected = undefined;
      requests = [];
      issued = [];
      lastCallback = undefined;
      grants.clear();
      accessTokens.clear();
    },
    async close() {
      closed = true;
      dropHeld();
      await stopListening();
    },
  };
}
