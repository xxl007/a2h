// Request ids and handles (spec protocol/schemas "Identifier formats").
// Randomness is an argument: the caller draws the bytes (crypto.getRandomValues
// in apps/mcp), so this module stays pure and testable.
import { HANDLE_MAX_LENGTH, HANDLE_PATTERN, REQUEST_ID_PATTERN } from "./primitives.ts";

const SUFFIX_BYTES = 2;

function hexSuffix(randomness: Uint8Array): string {
  if (randomness.length !== SUFFIX_BYTES) throw new RangeError(`exactly ${SUFFIX_BYTES} bytes of randomness are required`);
  return Array.from(randomness, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `A2H-` + four lower-case hex characters from two given random bytes. */
export function formatRequestId(randomness: Uint8Array): string {
  return `A2H-${hexSuffix(randomness)}`;
}

export function isRequestId(text: string): boolean {
  return REQUEST_ID_PATTERN.test(text);
}

/** Returns the id unchanged, or throws a RangeError for anything but `A2H-` + four lower-case hex. */
export function parseRequestId(text: string): string {
  if (!isRequestId(text)) throw new RangeError("malformed request id");
  return text;
}

/** `<slug>-<four hex>` from a lower-case slug (letters, digits, inner hyphens) and two random bytes. */
export function formatHandle(slug: string, randomness: Uint8Array): string {
  const handle = `${slug}-${hexSuffix(randomness)}`;
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) || handle.length > HANDLE_MAX_LENGTH) {
    throw new RangeError("malformed handle slug");
  }
  return handle;
}

/** Splits a handle into slug and suffix; throws a RangeError on a malformed handle. */
export function parseHandle(text: string): { slug: string; suffix: string } {
  if (text.length > HANDLE_MAX_LENGTH || !HANDLE_PATTERN.test(text)) throw new RangeError("malformed handle");
  const cut = text.lastIndexOf("-");
  return { slug: text.slice(0, cut), suffix: text.slice(cut + 1) };
}
