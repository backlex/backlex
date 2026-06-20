// Receiver-side helper for verifying inbound backlex webhook signatures.
// Runs anywhere Web Crypto is available (Workers, Node 18+, Bun, Deno).

export interface VerifyWebhookOptions {
  /** The hook's signing secret (the `secret` you configured on the webhook). */
  secret: string;
  /** The raw request body, exactly as received — do NOT re-stringify a parsed
   *  object, or the bytes (and therefore the HMAC) won't match. */
  body: string;
  /** The signature header value to check. Pass `X-Backlex-Signature-V2`
   *  together with `timestamp` for replay protection, or the legacy
   *  `X-Backlex-Signature` on its own. */
  signature: string;
  /** The `X-Backlex-Timestamp` header. When present, the replay-safe V2 scheme
   *  is verified and the delivery is rejected if the timestamp is too old. */
  timestamp?: string | number;
  /** Allowed clock skew for the timestamp, in seconds (default 300). `0`
   *  disables the freshness check. Ignored when no `timestamp` is supplied. */
  toleranceSec?: number;
}

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return toHex(sig);
};

/** Constant-time hex compare — avoids leaking match progress via timing. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Verify a backlex webhook delivery's signature.
 *
 * Replay-safe path (recommended) — pass the `X-Backlex-Signature-V2` header as
 * `signature` and the `X-Backlex-Timestamp` header as `timestamp`:
 *
 * ```ts
 * const ok = await verifyWebhook({
 *   secret,
 *   body: await req.text(),
 *   signature: req.headers.get("x-backlex-signature-v2")!,
 *   timestamp: req.headers.get("x-backlex-timestamp")!,
 * });
 * ```
 *
 * Legacy path — pass only the `X-Backlex-Signature` header (no replay window).
 * Returns `false` (never throws) on any missing input, stale timestamp, or
 * mismatch.
 */
export const verifyWebhook = async (
  opts: VerifyWebhookOptions,
): Promise<boolean> => {
  const { secret, body, signature } = opts;
  if (!secret || !signature) return false;
  const hasTs =
    opts.timestamp !== undefined &&
    opts.timestamp !== null &&
    opts.timestamp !== "";
  if (hasTs) {
    const ts = Number(opts.timestamp);
    if (!Number.isFinite(ts)) return false;
    const tolerance = opts.toleranceSec ?? 300;
    if (tolerance > 0 && Math.abs(Date.now() / 1000 - ts) > tolerance) {
      return false;
    }
    const expected = await hmacHex(secret, `${ts}.${body}`);
    return timingSafeEqual(expected, signature);
  }
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(expected, signature);
};
