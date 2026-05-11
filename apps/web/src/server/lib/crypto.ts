/**
 * Symmetric encryption for small secrets stored in the database (e.g. a
 * workspace's OAuth client secrets in `auth_config`). AES-256-GCM with a key
 * derived from `AUTH_SECRET` — so the ciphertext is useless without the
 * deployment's signing secret, and rotating that secret invalidates stored
 * secrets (they fail to decrypt and the workspace re-enters them).
 *
 * Uses the Web Crypto API (`crypto.subtle`) — available on Cloudflare
 * Workers, Bun, and Node 18+.
 */

const ENC_PREFIX = "enc:v1:";

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const b64decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// `crypto.subtle` parameters are typed as `BufferSource`, but the strict
// lib.dom types distinguish `ArrayBuffer` from `ArrayBufferLike`; the casts
// below paper over that without copying.
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

const deriveKey = async (secret: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.digest(
    "SHA-256",
    buf(new TextEncoder().encode(`workeros:auth-config-secret:v1:${secret}`)),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
};

/** Encrypt a UTF-8 string. Output is `enc:v1:<base64 iv>:<base64 ciphertext+tag>`. */
export const encryptSecret = async (
  plaintext: string,
  secret: string,
): Promise<string> => {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv) },
      key,
      buf(new TextEncoder().encode(plaintext)),
    ),
  );
  return `${ENC_PREFIX}${b64encode(iv)}:${b64encode(ct)}`;
};

/** True if `value` looks like an output of {@link encryptSecret}. */
export const isEncryptedSecret = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith(ENC_PREFIX);

/**
 * Decrypt a value produced by {@link encryptSecret}. Returns `null` on any
 * failure (wrong format, wrong key, tampered ciphertext) so callers can fall
 * back gracefully instead of throwing on a request path.
 */
export const decryptSecret = async (
  value: string,
  secret: string,
): Promise<string | null> => {
  if (!isEncryptedSecret(value)) return null;
  const rest = value.slice(ENC_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  try {
    const iv = b64decode(rest.slice(0, sep));
    const ct = b64decode(rest.slice(sep + 1));
    const key = await deriveKey(secret);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(iv) },
      key,
      buf(ct),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
};
