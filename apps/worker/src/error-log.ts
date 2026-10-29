// How the worker logs an error (design D9, review N7): its name and, for a
// Postgres error, the SQLSTATE code. Never the message: a pg message can
// carry a value from the statement (`invalid input syntax …: "<value>"`),
// and never the error object or its stack. The one exception is the
// deployment adapter's configuration message (infra/env.ts), fixed text that
// names a variable and never its value, kept so a bad deployment is legible.
import type { WorkerLogLine } from "./log.ts";

const SQLSTATE = /^[0-9A-Z]{5}$/;
const CONFIG_PREFIX = "worker configuration: ";

export function errorFields(error: unknown): WorkerLogLine {
  if (!(error instanceof Error)) return { error: "unknown" };
  const fields: WorkerLogLine = { error: error.name };
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && SQLSTATE.test(code)) fields["code"] = code;
  if (error.message.startsWith(CONFIG_PREFIX)) fields["detail"] = error.message;
  return fields;
}
