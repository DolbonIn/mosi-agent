/**
 * Structured, secret-free logging. Every line starts with `[pickle/server]` and carries only
 * identifiers/counters — never request bodies, tokens, passwords, phone numbers or message text.
 */

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const SECRETISH = /(token|password|secret|key|authorization|cookie)/i;

function fmt(event: string, fields?: LogFields): string {
  if (!fields) return `[pickle/server] ${event}`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const value = SECRETISH.test(k) ? "[redacted]" : String(v).replace(/\s+/g, " ").slice(0, 160);
    parts.push(`${k}=${value}`);
  }
  return `[pickle/server] ${event}${parts.length ? " " + parts.join(" ") : ""}`;
}

export function createLogger(opts: { quiet?: boolean } = {}): Logger {
  if (opts.quiet) return { info() {}, warn() {}, error() {} };
  return {
    info: (e, f) => console.log(fmt(e, f)),
    warn: (e, f) => console.warn(fmt(e, f)),
    error: (e, f) => console.error(fmt(e, f)),
  };
}

/** Error → short, secret-free description for logs. */
export function errInfo(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    return `${err.name}${typeof status === "number" ? `(${status})` : ""}: ${err.message.slice(0, 120)}`;
  }
  return String(err).slice(0, 120);
}
