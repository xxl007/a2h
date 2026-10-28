// Structured logging (design D9). One JSON object per line. A line carries
// ids, states, codes and durations: never a question, an answer body, a
// name, an email or any other personal data, and never a secret.

/** One structured log line. Values are scalars only, so no object (a manifest, an answer) can be logged whole. */
export type LogLine = Record<string, string | number | boolean | undefined>;

export type Log = (line: LogLine) => void;

/**
 * The fields a tool call may log (D9: `request_id`, `principal_id`,
 * `participant_id`, state and code). `request_id` is the A2H request id
 * (`A2H-7f3c`); `http_request_id` correlates with the access log line.
 */
export interface ToolLogFields {
  tool: string;
  outcome: "ok" | "error" | "input_required" | "not_sent";
  http_request_id?: string | undefined;
  request_id?: string | undefined;
  principal_id?: string | undefined;
  participant_id?: string | undefined;
  state?: string | undefined;
  code?: string | undefined;
  stage?: string | undefined;
  results?: number | undefined;
  duration_ms?: number | undefined;
}

export function toolLogLine(fields: ToolLogFields): LogLine {
  const line: LogLine = { level: fields.outcome === "error" ? "warn" : "info", msg: "tool call" };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v as string | number;
  return line;
}
