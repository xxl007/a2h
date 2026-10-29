// Display forms shown to principals (protocol skill §9, §10). Pure strings
// from protocol values; no locale or clock is consulted.
import type { RatingSummary } from "./profile.ts";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `~45m`, `~6h`, `~3d`: minutes under an hour, hours under 48 hours, days beyond. */
export function latencyDisplay(seconds: number): string {
  if (seconds < 3600) return `~${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 48 * 3600) return `~${Math.round(seconds / 3600)}h`;
  return `~${Math.round(seconds / 86400)}d`;
}

/** The auditable ranking string: `4.8 · 48 answers · 0 disputes · ~6h`. */
export function rankingDisplay(r: RatingSummary): string {
  return [r.rating.toFixed(1), plural(r.answers, "answer"), plural(r.disputes_lost, "dispute"), latencyDisplay(r.typical_latency_seconds)].join(" · ");
}

/** `a2h:sig:…` followed by the signature's last four characters. */
export function signatureDisplay(signature: string): string {
  return `a2h:sig:…${signature.slice(-4)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * The citable form: `reviewed by M.V., 21 Oct 2026`. Initials come from the
 * display label (a parenthesised marker such as "(simulated)" is ignored);
 * the date is the calendar date of `signed_at` in the signer's own offset.
 */
export function citation(displayLabel: string, signedAt: string): string {
  const words = displayLabel.replace(/\([^)]*\)/g, " ").split(/[\s.]+/).filter((w) => /\p{L}/u.test(w));
  const initials = words.map((w) => `${(w.match(/\p{L}/u)?.[0] ?? "").toUpperCase()}.`).join("");
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(signedAt);
  if (!m) throw new RangeError("signed_at is not an ISO date-time");
  const [, year, month, day] = m;
  return `reviewed by ${initials}, ${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}
