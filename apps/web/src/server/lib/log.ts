/**
 * Structured JSON logging.
 *
 * Every line is a single `JSON.stringify`d object printed to stdout/stderr via
 * `console.*`. On Cloudflare Workers this lands in Workers Observability /
 * Logpush; on Bun / Vercel / Netlify it lands in the platform's log drain.
 * Emitting JSON (rather than Hono's human-readable `logger()`) is what makes
 * the logs queryable — filter by `requestId`, `tenantId`, `status`, `level`,
 * etc. without regex-scraping free text.
 *
 * The level threshold is process/isolate-global and configured once per isolate
 * from `env.LOG_LEVEL` in `createApp`. Default is `info`. Set `LOG_LEVEL=warn`
 * (or `error`) to suppress the per-request access log; `LOG_LEVEL=debug` to
 * include health-check noise; `LOG_LEVEL=silent` to mute everything.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Per-isolate threshold. Lines below it are dropped before any stringify cost.
let threshold = ORDER.info;

/** Configure the global level threshold from an env string. Unknown values
 *  leave the current threshold untouched (fail-safe — never silently mute). */
export const configureLogLevel = (level?: string): void => {
  const l = (level ?? "").trim().toLowerCase();
  if (!l) return;
  if (l === "silent" || l === "off" || l === "none") {
    threshold = Number.POSITIVE_INFINITY;
    return;
  }
  if (l in ORDER) threshold = ORDER[l as LogLevel];
};

const emit = (
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void => {
  if (ORDER[level] < threshold) return;
  let line: string;
  try {
    line = JSON.stringify({ level, msg, ts: Date.now(), ...fields });
  } catch {
    // A non-serializable field (cycle, BigInt) must never crash the request —
    // fall back to a minimal line.
    line = JSON.stringify({ level, msg, ts: Date.now() });
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit("error", msg, fields),
};

/** Map an HTTP status to the log level its access/error line should use. */
export const levelForStatus = (status: number): LogLevel =>
  status >= 500 ? "error" : status >= 400 ? "warn" : "info";
