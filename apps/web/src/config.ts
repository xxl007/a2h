// What apps/web reads from its environment (infra/web.ts sets it on the
// Lambda). Pure: the caller passes the environment. No error message carries
// a value, only the variable's name.
//
// - STAGE, MCP_URL (the stage's MCP URL, the `resource` tokens are bound to),
//   AUTH_ISSUER (`https://<web host>/api/auth`; infra sets it once the stage
//   has a domain: the MCP plugin requires an https resource, so a stage
//   without a domain has no authorization server),
//   BETTER_AUTH_SECRET (cookie signing, hashing, key encryption).
// - STORAGE_PREFIX and UPLOADS_BUCKET: the mail sink `tmp/<prefix>mail/` (D6).
// - EMAIL_FROM: the SES sender (required on prod).
// - ALLOWLIST_PARAMETER (SSM SecureString, D7) and PRINCIPAL_ALLOWLIST
//   (fallback list until the parameter exists).
// - PRINCIPAL_CURRENCY … PRINCIPAL_THROTTLED_DAILY_LIMIT: the stage's default
//   policy given to a principal at first consent (D4), the names the mcp
//   service uses (infra/service-env.ts).
// - AUTH_CLIENTS_JSON (optional): pre-registered clients (D8).
import { ValidationPolicySchema } from "@a2h/protocol";
import * as z from "zod";

type Env = Record<string, string | undefined>;

export interface PreRegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  /** base64url (no padding) SHA-256 of the client secret, as Better Auth stores it; absent for a public client. */
  client_secret_sha256?: string;
}

export interface WebConfig {
  stage: string;
  /** Shown on non-prod screens ("Test stage pr-12"); undefined on prod. */
  stageName: string | undefined;
  mcpUrl: string;
  /** `https://<web host>/api/auth`. */
  issuer: string;
  /** The issuer's origin (Better Auth `baseURL`). */
  baseURL: string;
  secret: string;
  /** Prefix for the mail sink, `tmp/<STORAGE_PREFIX>` (the sink appends `mail/`). */
  mailSinkPrefix: string;
  uploadsBucket: string;
  emailFrom: string;
  allowlist: { parameter: string | undefined; fallback: string };
  defaultPolicy: {
    currency: string;
    monthly_budget_minor: number;
    per_request_cap_minor: number;
    ask_first_above_minor: number | null;
    daily_request_limit: number;
    throttled_daily_limit: number;
  };
  clients: PreRegisteredClient[];
}

const PR_STAGE = /^pr-[1-9][0-9]*$/;
const SECRET_MIN_LENGTH = 32;
export const AUTH_BASE_PATH = "/api/auth";

function fail(message: string): never {
  throw new Error(`web configuration: ${message}`);
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") fail(`${name} is not set`);
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function integer(env: Env, name: string): number {
  const text = required(env, name);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) fail(`${name} is not a non-negative integer`);
  return Number(text);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function httpsUrl(env: Env, name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} is not a URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    fail(`${name} must be https (http only on a loopback host)`);
  }
  if (url.search || url.hash || url.username || url.password) fail(`${name} must have no query, fragment or credentials`);
  return url;
}

const RedirectUri = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
});

const ClientsSchema = z.array(
  z.strictObject({
    client_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    client_name: z.string().min(1).max(200),
    redirect_uris: z.array(RedirectUri).min(1),
    client_secret_sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  }),
);

function clientsFromEnv(env: Env): PreRegisteredClient[] {
  const text = optional(env, "AUTH_CLIENTS_JSON");
  if (text === undefined) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("AUTH_CLIENTS_JSON is not JSON");
  }
  const parsed = ClientsSchema.safeParse(raw);
  if (!parsed.success) fail("AUTH_CLIENTS_JSON is not a list of {client_id, client_name, redirect_uris, client_secret_sha256?}");
  return parsed.data.map((c) => ({
    client_id: c.client_id,
    client_name: c.client_name,
    redirect_uris: c.redirect_uris,
    ...(c.client_secret_sha256 !== undefined ? { client_secret_sha256: c.client_secret_sha256 } : {}),
  }));
}

export function webConfigFromEnv(env: Env = process.env): WebConfig {
  const stage = required(env, "STAGE");
  if (stage !== "dev" && stage !== "prod" && !PR_STAGE.test(stage)) fail("STAGE is not dev, prod or pr-<n>");
  const prod = stage === "prod";

  const mcpUrl = httpsUrl(env, "MCP_URL", required(env, "MCP_URL")).toString();

  const issuerUrl = httpsUrl(env, "AUTH_ISSUER", required(env, "AUTH_ISSUER"));
  if (issuerUrl.pathname !== AUTH_BASE_PATH) fail(`AUTH_ISSUER must be <origin>${AUTH_BASE_PATH}`);
  const issuer = `${issuerUrl.origin}${AUTH_BASE_PATH}`;
  const baseURL = issuerUrl.origin;

  const secret = required(env, "BETTER_AUTH_SECRET");
  if (secret.length < SECRET_MIN_LENGTH) fail(`BETTER_AUTH_SECRET is shorter than ${SECRET_MIN_LENGTH} characters`);

  const storagePrefix = required(env, "STORAGE_PREFIX");
  if (!/^(dev|prod|pr-[1-9][0-9]*)\/$/.test(storagePrefix)) fail("STORAGE_PREFIX is not <stage>/");
  const uploadsBucket = prod ? optional(env, "UPLOADS_BUCKET") ?? "" : required(env, "UPLOADS_BUCKET");
  const emailFrom = prod ? required(env, "EMAIL_FROM") : optional(env, "EMAIL_FROM") ?? "";

  const askFirst = required(env, "PRINCIPAL_ASK_FIRST_ABOVE_MINOR");
  const policyEnv: Record<string, string> = {
    currency: "PRINCIPAL_CURRENCY",
    monthly_budget_minor: "PRINCIPAL_MONTHLY_BUDGET_MINOR",
    per_request_cap_minor: "PRINCIPAL_PER_REQUEST_CAP_MINOR",
    ask_first_above_minor: "PRINCIPAL_ASK_FIRST_ABOVE_MINOR",
    daily_request_limit: "PRINCIPAL_DAILY_REQUEST_LIMIT",
    throttled_daily_limit: "PRINCIPAL_THROTTLED_DAILY_LIMIT",
  };
  const policy = ValidationPolicySchema.omit({ fee_rate: true }).safeParse({
    currency: required(env, "PRINCIPAL_CURRENCY"),
    monthly_budget_minor: integer(env, "PRINCIPAL_MONTHLY_BUDGET_MINOR"),
    per_request_cap_minor: integer(env, "PRINCIPAL_PER_REQUEST_CAP_MINOR"),
    ask_first_above_minor: askFirst === "none" ? null : integer(env, "PRINCIPAL_ASK_FIRST_ABOVE_MINOR"),
    daily_request_limit: integer(env, "PRINCIPAL_DAILY_REQUEST_LIMIT"),
    throttled_daily_limit: integer(env, "PRINCIPAL_THROTTLED_DAILY_LIMIT"),
  });
  if (!policy.success) {
    const field = String(policy.error.issues[0]?.path[0] ?? "");
    fail(`${policyEnv[field] ?? "the default policy"} is not valid`);
  }

  return {
    stage,
    stageName: prod ? undefined : stage,
    mcpUrl,
    issuer,
    baseURL,
    secret,
    mailSinkPrefix: `tmp/${storagePrefix}`,
    uploadsBucket,
    emailFrom,
    allowlist: { parameter: optional(env, "ALLOWLIST_PARAMETER"), fallback: optional(env, "PRINCIPAL_ALLOWLIST") ?? "" },
    defaultPolicy: policy.data,
    clients: clientsFromEnv(env),
  };
}
