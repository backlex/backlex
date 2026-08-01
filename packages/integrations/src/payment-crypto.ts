/**
 * The HMAC + encoding primitives the payment adapters share.
 *
 * Extracted so the INBOUND verifier (`./payments.ts`) and the OUTBOUND checkout
 * builder (`./checkout.ts`) sign with one implementation. PayTR is the reason
 * this matters: the same base64-HMAC-SHA256 construction authenticates the
 * token request going out and the callback coming back, and two copies of it
 * would be free to drift — at which point checkouts would be minted that the
 * receiver then rejects as forgeries.
 *
 * Deliberately NOT in the package's `exports` map: these are internals, not a
 * crypto library for consumers.
 */

export const enc = new TextEncoder();

/**
 * Domain separators for the two things the `dummy` provider's secret signs.
 *
 * They live here rather than next to either signer because BOTH sides need
 * them and the two modules already point one way (`checkout` imports
 * `payments`) — defining them in `payments` would close the cycle.
 *
 * Without a prefix the outbound checkout signature and the inbound settlement
 * signature are the same construction over attacker-visible text, so one
 * verifies as the other for identical bytes.
 */
export const DUMMY_CHECKOUT_DOMAIN = "backlex.dummy.checkout.v1\n";
export const DUMMY_SETTLEMENT_DOMAIN = "backlex.dummy.settlement.v1\n";

/**
 * The digests any provider here signs with. Every one used SHA-256 until
 * Authorize.net, which uses SHA-512 — so the algorithm became a parameter
 * rather than a constant. It is spelled out per call site instead of being read
 * off the signature's length: inferring it from the value would let a sender
 * choose the weaker one.
 */
export type HmacHash = "SHA-256" | "SHA-512";

const importHmacKey = (keyBytes: Uint8Array, hash: HmacHash): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    // A fresh copy pins the exact byte range — some runtimes reject a view
    // whose underlying buffer is larger than the view itself.
    "raw",
    keyBytes.slice().buffer as ArrayBuffer,
    { name: "HMAC", hash },
    false,
    ["sign"],
  );

export const hmac = async (
  keyBytes: Uint8Array,
  message: string,
  hash: HmacHash = "SHA-256",
): Promise<Uint8Array> => {
  const key = await importHmacKey(keyBytes, hash);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return new Uint8Array(sig);
};

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Hex string → bytes, or null if it isn't valid hex.
 *
 * Adyen is why this exists: the HMAC key its Customer Area hands out is the
 * hex ENCODING of the key bytes, so signing with the ASCII of that string
 * produces a signature that never matches. There is no way to tell the two
 * apart from the value alone — both are printable — which makes the mistake
 * silent and total.
 */
export const fromHex = (hex: string): Uint8Array | null => {
  const s = hex.trim();
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const fromBase64 = (b64: string): Uint8Array | null => {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

/** Length-independent, content-constant-time string compare. */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
