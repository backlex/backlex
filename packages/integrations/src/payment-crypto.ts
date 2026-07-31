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

const importHmacKey = (keyBytes: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    // A fresh copy pins the exact byte range — some runtimes reject a view
    // whose underlying buffer is larger than the view itself.
    "raw",
    keyBytes.slice().buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

export const hmac = async (keyBytes: Uint8Array, message: string): Promise<Uint8Array> => {
  const key = await importHmacKey(keyBytes);
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
