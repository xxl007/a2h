// Tool descriptions (spec mcp-transport "Tools are listed"; protocol skill
// §7). Every A2H tool description carries the policy: a human is a last
// resort, search and existing tools come first, the principal sees the
// exact question before anything is sent, and pays what clears, never more
// than the hold.

export const POLICY_TEXT =
  "Policy: humans are a last resort. Use A2H only when a human is the sole valid source; " +
  "search, existing tools and what you already know come first. " +
  "The principal is shown the exact question and approves it before anything is sent. " +
  "The principal pays what clears, never more than the hold.";

export const FIND_HUMANS_DESCRIPTION =
  "Find consenting humans who could answer a question no tool can: returns ranked handles " +
  "(never names or contact details) with their published terms (topics and evidence, rating, " +
  "latency promise, gross reserve per request type, free lanes, verification) and the ranking " +
  "inputs, so you can explain your recommendation. Searching contacts no one. " +
  "Before calling, state what you tried, why no tool can answer and what kind of person can. " +
  POLICY_TEXT;

export const REQUEST_HUMAN_DESCRIPTION =
  "Send one question to one participant found with find_humans, on behalf of the principal. " +
  "The server validates it against the participant's rules and the principal's policy, then " +
  "shows the principal the exact question (editable) with the bid, format, expiry and data " +
  "terms, and sends it only if they accept. Returns the request id, an ETA and the amount held " +
  "within a second; the answer comes later through check_requests. " +
  "Needs MCP protocol revision 2026-07-28 for the approval. " +
  POLICY_TEXT;

export const CHECK_REQUESTS_DESCRIPTION =
  "Check the principal's requests: one by id (A2H-xxxx) or a list filtered by status and time. " +
  "Reports the status, when each step happened, the amount held and, once answered, the " +
  "signed human answer (body, confidence, personal attestation, signature, time) and the " +
  "cleared amount. Show an answer as coming from a human, not from you. " +
  POLICY_TEXT;
