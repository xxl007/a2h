// Structured log lines (design D9): ids, states, codes and durations only.
// Never question text, answer bodies, names, emails or key material.
export type WorkerLogLine = Record<string, string | number | boolean | undefined>;
export type Log = (line: WorkerLogLine) => void;
