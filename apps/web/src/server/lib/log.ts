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
 *
 * When an OTLP collector is configured, lines are ALSO buffered here for
 * `services/otlp-logs.ts` to ship. Buffered rather than sent per line: one HTTP
 * request per log entry would cost more than the request being logged. The
 * buffer is bounded and drops the OLDEST entries when full, because in an
 * incident the newest lines are the ones being read.
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

/** One buffered line, in the shape the OTLP exporter needs. */
export interface BufferedLog {
  level: LogLevel;
  msg: string;
  ts: number;
  fields: Record<string, unknown>;
}

/**
 * Hard cap on buffered lines.
 *
 * An isolate that logs while its collector is down must not grow without
 * bound. 512 is a few seconds of a busy worker — enough that a normal request
 * flushes everything it produced, small enough that a wedged collector costs
 * kilobytes rather than the isolate.
 */
const MAX_BUFFERED = 512;

let buffer: BufferedLog[] | null = null;
let dropped = 0;

/** Start (or stop) buffering for the OTLP log exporter. Off by default: with no
 *  collector configured there is nothing to buffer FOR, and paying the cost
 *  anyway would be a memory leak with no consumer. */
export const configureLogBuffer = (enabled: boolean): void => {
  buffer = enabled ? (buffer ?? []) : null;
  if (!enabled) dropped = 0;
};

/** Take everything buffered so far. Returns `[]` when buffering is off. */
export const drainLogBuffer = (): { records: BufferedLog[]; dropped: number } => {
  if (!buffer || buffer.length === 0) {
    const d = dropped;
    dropped = 0;
    return { records: [], dropped: d };
  }
  const records = buffer;
  buffer = [];
  const d = dropped;
  dropped = 0;
  return { records, dropped: d };
};

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

  if (buffer) {
    if (buffer.length >= MAX_BUFFERED) {
      // Oldest out: during an incident the newest lines are what is being read.
      buffer.shift();
      dropped++;
    }
    buffer.push({ level, msg, ts: Date.now(), fields: fields ?? {} });
  }
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
