// The budget a principal has committed, as the server counts it (issue #114).
// Pure: the live guard (contract/a2h.ts `usage`, `budgetGuard`) feeds it the
// requests check_requests lists, and lib/budget.test.ts pins it to the
// server's rule.
//
// The server's rule (packages/db/src/queries/mcp.ts `principalUsage`, read by
// `approvalFacts` in queries/approval.ts for request_human and for Send on the
// approval page; packages/protocol validate.ts stage 5 refuses with
// over_budget when used + bid > monthly budget):
//   - requests created since the UTC month start;
//   - `sent` and `accepted` count their bid (check_requests: `held_minor`,
//     the bid on the paid lane, 0 on a free lane whose bid is 0);
//   - `answered` counts its cleared amount, or the bid when none is recorded
//     (check_requests always reports `cleared_minor` on an answered request);
//   - every other status counts nothing: `awaiting_approval` and `not_sent`
//     (no hold before Send), and `declined`, `expired`, `cancelled` (the hold
//     is released).
//   The daily request limit counts requests created since the UTC day start
//   that are not `awaiting_approval` or `not_sent`.
import type { CheckedRequest } from "@a2h/protocol";

/** The statuses that hold or have cleared budget. */
export const COMMITTING_STATUSES = ["sent", "accepted", "answered"] as const;
/** The statuses the daily request limit counts (every status after a Send). */
export const SENT_STATUSES = ["sent", "accepted", "answered", "declined", "expired", "cancelled"] as const;
/** check_requests returns at most this many requests per call. */
export const LIST_LIMIT = 100;

/** When the server created the request: its awaiting_approval event, or its send for requests from before the approval page. */
export function createdAt(r: Pick<CheckedRequest, "transitions">): number | undefined {
  const at = r.transitions.awaiting_approval_at ?? r.transitions.sent_at;
  return at === undefined ? undefined : Date.parse(at);
}

/** What one request counts against the monthly budget, by the server's rule. */
export function committedBy(r: Pick<CheckedRequest, "status" | "held_minor" | "cleared_minor">): number {
  switch (r.status) {
    case "sent":
    case "accepted":
      return r.held_minor ?? 0;
    case "answered":
      return r.cleared_minor ?? r.held_minor ?? 0;
    default:
      return 0;
  }
}

export interface Usage {
  /** Gross amount committed this UTC month, as the server's budget stage sees it. */
  committed_minor: number;
  /** Requests created today (UTC) and sent, as the daily limit counts them. */
  requests_today: number;
  /** false when a listing came back full: then more requests may exist than were seen, and the figures are lower bounds. */
  complete: boolean;
}

/**
 * Usage from listings by status (each `since` the month start, at most
 * LIST_LIMIT). Requests created before `monthStart` count for nothing.
 */
export function usageOf(byStatus: Record<string, CheckedRequest[]>, monthStart: Date, dayStart: Date): Usage {
  let committed = 0;
  let today = 0;
  let complete = true;
  const seen = new Set<string>();
  for (const [status, list] of Object.entries(byStatus)) {
    if (list.length >= LIST_LIMIT) complete = false;
    for (const r of list) {
      if (r.status !== status || seen.has(r.request_id)) continue;
      seen.add(r.request_id);
      const created = createdAt(r);
      if (created === undefined || created < monthStart.getTime()) continue;
      committed += committedBy(r);
      if ((SENT_STATUSES as readonly string[]).includes(r.status) && created >= dayStart.getTime()) today++;
    }
  }
  return { committed_minor: committed, requests_today: today, complete };
}

/**
 * The guard's verdict: a skip reason when spending `cost_minor` over
 * `requests` more requests would take the principal past what the server
 * accepts (the same boundary: refused when used + bid > budget), or when the
 * usage cannot be read completely; false otherwise.
 */
export function guardVerdict(u: Usage, policy: { monthly_budget_minor: number; daily_request_limit: number }, cost_minor: number, requests: number): string | false {
  const state = `committed ${u.committed_minor} of ${policy.monthly_budget_minor} minor units this month, ${u.requests_today} of ${policy.daily_request_limit} requests sent today`;
  if (!u.complete) return `budget guard: more than ${LIST_LIMIT} requests in one status this month, so the usage cannot be read completely (${state} at least)`;
  if (u.committed_minor + cost_minor > policy.monthly_budget_minor) {
    return `budget guard: ${state}; this flow commits up to ${cost_minor} more, and the server would refuse with over_budget`;
  }
  if (u.requests_today + requests > policy.daily_request_limit) {
    return `budget guard: ${state}; this flow sends up to ${requests} more, past the principal's daily limit`;
  }
  return false;
}
