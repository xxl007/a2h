// The approval link (m2-approval-page design D2), pure: the caller draws the
// token's 32 random bytes and passes the clock in. The link is
// `https://<web host>/approve/<request id>?t=<token>`; only the token's
// SHA-256 is stored, and the token alone grants nothing (the page also
// requires the request's principal, signed in).
import * as z from "zod";
import { RequestIdSchema } from "./primitives.ts";

/** At most 24 hours (proposal decision 3). */
export const APPROVAL_LINK_MAX_SECONDS = 24 * 3600;
/** Less than this before the request could still be answered in time: no link (the latency refusal applies). */
export const APPROVAL_LINK_MIN_SECONDS = 15 * 60;

const TOKEN_BYTES = 32;
/** 32 bytes in base64url without padding: 43 characters. */
export const ApprovalTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The token for 32 random bytes the caller drew. */
export function formatApprovalToken(bytes: Uint8Array): ApprovalToken {
  if (bytes.length !== TOKEN_BYTES) throw new TypeError(`an approval token is ${TOKEN_BYTES} random bytes`);
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  // 32 = 30 + 2: two bytes left, three characters.
  const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
  out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  return out;
}

/** What is stored for a token: its SHA-256, lower-case hex. Compare hashes, never tokens. */
export async function approvalTokenHash(token: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new TypeError("WebCrypto (crypto.subtle) is not available");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The approval link on the stage's web host. */
export function approvalUrl(webOrigin: string, requestId: string, token: string): string {
  const origin = new URL(webOrigin);
  if (origin.protocol !== "https:") throw new TypeError("the approval link is https only");
  if (!RequestIdSchema.safeParse(requestId).success) throw new TypeError("not a request id");
  if (!ApprovalTokenSchema.safeParse(token).success) throw new TypeError("not an approval token");
  return `${origin.origin}/approve/${requestId}?t=${token}`;
}

/**
 * When the link expires (D2): the earlier of 24 hours from now and the
 * request's own expiry minus the participant's latency promise; null when
 * that leaves less than 15 minutes. UTC ISO string.
 */
export function approvalLinkExpiry(i: { now: string; expires_at: string; latency_promise_seconds: number }): string | null {
  const now = Date.parse(i.now);
  const latest = Date.parse(i.expires_at) - i.latency_promise_seconds * 1000;
  if (!Number.isFinite(now) || !Number.isFinite(latest)) throw new TypeError("now and expires_at are ISO 8601 date-times");
  const at = Math.min(now + APPROVAL_LINK_MAX_SECONDS * 1000, latest);
  return at - now >= APPROVAL_LINK_MIN_SECONDS * 1000 ? new Date(at).toISOString() : null;
}
