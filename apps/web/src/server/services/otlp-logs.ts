/**
 * OTLP/HTTP log exporter.
 *
 * The trace exporter next door ships one span per request. This ships the
 * STRUCTURED LOG LINES that request produced, to the same collector and under
 * the same config — so `traceId` correlates a span with the lines written while
 * it was open, which is the whole reason to send logs to a collector rather
 * than read them in a platform dashboard.
 *
 * Same non-blocking contract as the trace path: telemetry must never add
 * latency to, or fail, the request that produced it. A down collector costs a
 * console line and nothing else.
 *
 * On Workers, `console.log` still lands in Workers Observability regardless —
 * this is in addition, not instead. Losing an export must never mean losing the
 * log.
 */
import type { Env } from "../env";
import type { BufferedLog, LogLevel } from "../lib/log";
import { drainLogBuffer } from "../lib/log";
import { parseOtlpHeaders } from "./otlp";

export const otlpLogsUrl = (endpoint: string): string => {
  const base = endpoint.trim().replace(/\/+$/, "");
  return base.endsWith("/v1/logs") ? base : `${base}/v1/logs`;
};

/** OpenTelemetry severity numbers. The names travel too, so a collector that
 *  only understands one of them still renders something useful. */
const SEVERITY: Record<LogLevel, { number: number; text: string }> = {
  debug: { number: 5, text: "DEBUG" },
  info: { number: 9, text: "INFO" },
  warn: { number: 13, text: "WARN" },
  error: { number: 17, text: "ERROR" },
};

/**
 * One log field → one OTLP attribute.
 *
 * Objects and arrays are JSON-encoded rather than dropped: unlike the warehouse
 * destinations, where a nested value would land in a typed column, an OTLP
 * attribute is free text and the nested shape is often the useful part (an
 * error's context, a query shape). `undefined` is skipped — an attribute with
 * no value is not the same as one that was absent.
 */
const toAttr = (key: string, value: unknown): Record<string, unknown> | null => {
  if (value === undefined) return null;
  if (value === null) return { key, value: { stringValue: "" } };
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  try {
    return { key, value: { stringValue: JSON.stringify(value) } };
  } catch {
    // A cycle or a BigInt must not cost the whole batch.
    return null;
  }
};

/**
 * Build the OTLP/HTTP JSON body for a batch of lines. Exported for tests.
 *
 * `traceId` / `spanId` are lifted out of the fields and onto the record itself
 * where present, because that is where a collector looks to join a log to its
 * span. Left as ordinary attributes they would render but not correlate.
 */
export const buildOtlpLogsPayload = (records: readonly BufferedLog[]): Record<string, unknown> => ({
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "backlex" } }] },
      scopeLogs: [
        {
          scope: { name: "backlex" },
          logRecords: records.map((r) => {
            const severity = SEVERITY[r.level];
            const traceId = typeof r.fields.traceId === "string" ? r.fields.traceId : undefined;
            const spanId = typeof r.fields.spanId === "string" ? r.fields.spanId : undefined;
            const attributes = Object.entries(r.fields)
              .filter(([k]) => k !== "traceId" && k !== "spanId")
              .map(([k, v]) => toAttr(k, v))
              .filter((a): a is Record<string, unknown> => a !== null);
            return {
              timeUnixNano: String(BigInt(Math.round(r.ts)) * 1_000_000n),
              severityNumber: severity.number,
              severityText: severity.text,
              body: { stringValue: r.msg },
              attributes,
              ...(traceId ? { traceId } : {}),
              ...(spanId ? { spanId } : {}),
            };
          }),
        },
      ],
    },
  ],
});

/**
 * Ship whatever the isolate has buffered. Never throws.
 *
 * Called once per request from the same hook that exports the span, so a line
 * is delivered inside the request that produced it — no timers, which is the
 * only thing that works the same way on Workers, Bun, Vercel and Netlify.
 */
export const flushLogsOtlp = async (
  env: Pick<Env, "OTLP_ENDPOINT" | "OTLP_HEADERS">,
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  const endpoint = (env.OTLP_ENDPOINT ?? "").trim();
  if (!endpoint) return;
  const { records, dropped } = drainLogBuffer();
  if (records.length === 0 && dropped === 0) return;

  if (dropped > 0) {
    // Reported rather than swallowed: a gap in the exported logs that nothing
    // announces reads as "nothing happened", which is the opposite of true.
    records.push({
      level: "warn",
      msg: "otlp log buffer overflowed",
      ts: Date.now(),
      fields: { dropped },
    });
  }

  try {
    const res = await fetchImpl(otlpLogsUrl(endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", ...parseOtlpHeaders(env.OTLP_HEADERS) },
      body: JSON.stringify(buildOtlpLogsPayload(records)),
    });
    if (!res.ok) {
      // `console.error` and not `log.error`: writing through the logger here
      // would buffer a line about the buffer failing to flush, on every flush.
      console.error(`[otlp-logs] collector responded ${res.status}`);
    }
  } catch (e) {
    console.error("[otlp-logs] export failed", e);
  }
};
