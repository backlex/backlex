/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/).
 *
 * The single source of truth for the `traceparent` header the whole stack
 * speaks: the SDK stamps it on outbound requests, this server parses it, and
 * functions / outbound calls re-emit it so one logical operation keeps the same
 * `traceId` across hops. Runtime-agnostic — only uses `crypto.getRandomValues`,
 * which exists on Workers / Bun / Vercel / Netlify alike.
 *
 *   traceparent: <version>-<trace-id>-<parent-id>-<flags>
 *   00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 *      └ 32 hex (16 bytes)              └ 16 hex (8 bytes) └ 8-bit flags
 */

/** A parsed/derived trace context for one request. */
export interface TraceContext {
  /** 32-hex trace id shared by every span in the operation. */
  traceId: string;
  /** 16-hex id of THIS span (the current request). */
  spanId: string;
  /** 16-hex id of the calling span, or null when this request started the trace. */
  parentSpanId: string | null;
  /** Whether the trace is sampled (the `01` flag bit). */
  sampled: boolean;
}

/** `bytes` random bytes as lowercase hex (length = `bytes * 2`). */
const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
};

/** A fresh 16-byte (32-hex) trace id. */
export const newTraceId = (): string => randomHex(16);
/** A fresh 8-byte (16-hex) span id. */
export const newSpanId = (): string => randomHex(8);

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO_TRACE = "0".repeat(32);
const ALL_ZERO_SPAN = "0".repeat(16);

/** Parse a `traceparent` header. Returns null if absent or malformed (per the
 *  spec a malformed value is ignored and a new trace is started). */
export const parseTraceparent = (
  header: string | null | undefined,
): { traceId: string; parentSpanId: string; sampled: boolean } | null => {
  if (!header) return null;
  const m = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  if (!m) return null;
  const traceId = m[2];
  const parentSpanId = m[3];
  const flags = m[4];
  if (!traceId || !parentSpanId || !flags) return null;
  // Spec: all-zero ids are invalid.
  if (traceId === ALL_ZERO_TRACE || parentSpanId === ALL_ZERO_SPAN) return null;
  return {
    traceId,
    parentSpanId,
    sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01,
  };
};

/** Serialize a context back to a `traceparent` header value (version `00`). */
export const formatTraceparent = (ctx: {
  traceId: string;
  spanId: string;
  sampled: boolean;
}): string =>
  `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;

/**
 * Derive the trace context for an incoming request: continue the inbound trace
 * when a valid `traceparent` is present (new child span id, parent = the
 * caller's span), else start a fresh trace. `forceSample` overrides the inbound
 * flag (used when the server samples 100%).
 */
export const deriveTraceContext = (
  header: string | null | undefined,
  forceSample = false,
): TraceContext => {
  const parent = parseTraceparent(header);
  if (parent) {
    return {
      traceId: parent.traceId,
      spanId: newSpanId(),
      parentSpanId: parent.parentSpanId,
      sampled: parent.sampled || forceSample,
    };
  }
  return {
    traceId: newTraceId(),
    spanId: newSpanId(),
    parentSpanId: null,
    sampled: forceSample || true,
  };
};
