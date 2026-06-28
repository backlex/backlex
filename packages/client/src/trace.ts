/**
 * W3C Trace Context generation for the SDK (https://www.w3.org/TR/trace-context/).
 *
 * Dependency-free — only `crypto.getRandomValues`, present in every modern
 * runtime the SDK targets (browsers, Node 18+, Bun, Deno, Workers). Mirrors the
 * server's `apps/web/src/server/lib/trace.ts`; kept in sync deliberately so the
 * `traceparent` the SDK emits is exactly what the API parses.
 *
 *   traceparent: 00-<32-hex trace id>-<16-hex span id>-<8-bit flags>
 */

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

/**
 * Build a `traceparent` value. With no args, starts a brand-new sampled trace
 * (fresh trace id + span id). Pass a `traceId` to continue an existing trace
 * (the SDK call becomes a child span of that trace).
 */
export const makeTraceparent = (traceId?: string, sampled = true): string =>
  `00-${traceId ?? newTraceId()}-${newSpanId()}-${sampled ? "01" : "00"}`;
