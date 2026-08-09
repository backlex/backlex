/**
 * The sending half of [Standard Webhooks](https://www.standardwebhooks.com).
 *
 * Every other outbound call backlex makes is signed with our own scheme
 * (`x-backlex-signature`, hex HMAC over `${timestamp}.${body}`). Auth hooks
 * deliberately use this one instead, and the reason is ecosystem fit rather
 * than cryptography: an auth hook is usually the FIRST thing an app implements
 * against us, and `standardwebhooks` verifier libraries already exist in every
 * language they might write it in. Two schemes is a real cost; a bespoke one
 * on the endpoint that gates sign-in is a bigger one.
 *
 * The format, exactly:
 *
 *   webhook-id         an opaque unique id for this delivery — also the
 *                      idempotency key an app should de-duplicate on
 *   webhook-timestamp  unix seconds, so a receiver can reject a replayed call
 *                      without parsing the signature
 *   webhook-signature  `v1,<base64 HMAC-SHA256>` over `${id}.${timestamp}.${body}`
 *                      (space-separated list — one entry per active secret)
 *
 * The secret is `whsec_<base64 key>`: the prefix is stripped and the remainder
 * base64-decoded to KEY BYTES. A secret that is not valid base64 is used as
 * raw UTF-8 bytes instead, which is what the spec's reference implementations
 * do and what our own `verifyPaymentSignature("polar", …)` already accepts —
 * the two are cross-checked by a test rather than trusted to agree.
 */

const enc = new TextEncoder();

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** Decode base64 to bytes, or null when the input is not base64. */
const fromBase64 = (b64: string): Uint8Array | null => {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

/** Key bytes for a Standard Webhooks secret. `whsec_` prefixed secrets carry a
 *  base64 key; anything else is used as raw bytes. */
export const standardWebhookKeyBytes = (secret: string): Uint8Array => {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return fromBase64(raw) ?? enc.encode(raw);
};

/**
 * Build the three signing headers for one delivery.
 *
 * `id` and `timestampSeconds` are injectable so a test can pin a known vector;
 * production callers pass neither.
 */
export const signStandardWebhook = async (
  secret: string,
  body: string,
  opts: { id?: string; timestampSeconds?: number } = {},
): Promise<{
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}> => {
  const id = opts.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = String(opts.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    standardWebhookKeyBytes(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`${id}.${timestamp}.${body}`) as unknown as BufferSource,
    ),
  );
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${toBase64(sig)}`,
  };
};

/** Mint a fresh `whsec_`-prefixed secret. 32 bytes of entropy, base64'd —
 *  the shape every Standard Webhooks verifier expects. */
export const generateStandardWebhookSecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${toBase64(bytes)}`;
};
