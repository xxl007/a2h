// Prints what the QA principals have committed on the stage under test, as
// the server counts it (lib/budget.ts, issue #114): amounts and counts only,
// never a token, an address or a link. The verify jobs run it after the
// steps that spend, so a run's log shows its spend step by step; on a
// preview the principals are fresh per run, so the figures are the run's.
// Run: A2H_MCP_URL=… A2H_TOKEN=… [A2H_TOKEN_2=…] node lib/spend.ts [label]
import { principalClient, stagePolicy, usage } from "../contract/a2h.ts";

const label = process.argv[2] ?? "now";
const policy = stagePolicy();
const principals: [string, string | undefined][] = [
  ["a", process.env["A2H_TOKEN"]],
  ["b", process.env["A2H_TOKEN_2"]],
];
for (const [name, token] of principals) {
  if (!token) continue;
  const c = await principalClient({ token });
  try {
    const u = await usage(c);
    console.log(
      `spend (${label}), principal ${name}: committed ${u.committed_minor} of ${policy.monthly_budget_minor} minor units this month ` +
        `(${policy.monthly_budget_minor - u.committed_minor} left), ${u.requests_today} of ${policy.daily_request_limit} requests sent today` +
        (u.complete ? "" : " (lower bounds: a listing came back full)"),
    );
  } finally {
    await c.close();
  }
}
