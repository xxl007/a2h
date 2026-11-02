// Structured logging for apps/web (design D10; a2h-protocol skill §11): one
// JSON object per line, opaque ids and codes only. Addresses, tokens, magic
// links, client secrets and query strings never reach a log line: every
// message and string field passes through `redact`, which removes anything
// shaped like an email address, a URL query, a JWT or a long random token,
// and only the fields named in `LogFields` are accepted.

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The only fields a log line may carry besides `level`, `msg` and `time`. */
export interface LogFields {
  request_id?: string;
  principal_id?: string;
  client_id?: string;
  /** A short machine code (`magic_link_requested`, `consent_accepted`, an error name). */
  code?: string;
  /** Path without its query string. */
  path?: string;
  status?: number;
  duration_ms?: number;
  stage?: string;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const EMAIL = /[^\s"'<>()[\]{},;:]+@[^\s"'<>()[\]{},;:]+\.[^\s"'<>()[\]{},;:]+/g;
const QUERY = /\?[^\s"'<>]*/g;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// Random tokens (magic-link tokens, codes, refresh tokens, secrets): a long
// run of token characters with a digit or mixed case. Snake-case codes such
// as `allowlist_refresh_failed` are kept.
const TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g;

/** Removes addresses, query strings, JWTs and long tokens from a string. */
export function redact(text: string): string {
  return text
    .replace(JWT, "[token]")
    .replace(EMAIL, "[address]")
    .replace(QUERY, "?[query]")
    .replace(TOKEN, (run) => (/[0-9]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run)) ? "[token]" : run));
}

const FIELD_NAMES: readonly (keyof LogFields)[] = [
  "request_id",
  "principal_id",
  "client_id",
  "code",
  "path",
  "status",
  "duration_ms",
  "stage",
];

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: {
  write?: (line: string) => void;
  level?: LogLevel;
  base?: LogFields;
  now?: () => Date;
} = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const min = ORDER[options.level ?? "info"];
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (ORDER[level] < min) return;
    const line: Record<string, unknown> = { level, time: now().toISOString(), msg: redact(msg) };
    const all = { ...options.base, ...fields };
    for (const name of FIELD_NAMES) {
      const value = all[name];
      if (value === undefined) continue;
      // Ids are opaque by construction; free text (code, path) is redacted.
      line[name] = typeof value === "string" && (name === "code" || name === "path") ? redact(value) : value;
    }
    write(JSON.stringify(line));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/**
 * Better Auth's `logger.log` hook. Its extra arguments (objects, errors that
 * may hold an address or a token) are reduced to an error name; only the
 * redacted message is kept.
 */
export function betterAuthLog(logger: Logger) {
  return (level: "debug" | "info" | "success" | "warn" | "error", message: string, ...args: unknown[]) => {
    const err = args.find((a): a is Error => a instanceof Error);
    const fields: LogFields = { code: err ? err.name : "better_auth" };
    const target = level === "success" ? "info" : level;
    logger[target](message, fields);
  };
}
