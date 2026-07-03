import { hashPassword, verifyPassword } from "better-auth/crypto";

/**
 * One-way secret hashing for `hash`-typed collection fields (passwords, PINs,
 * API secrets, …). Reuses better-auth's own scrypt primitives (`better-auth/
 * crypto`) so:
 *
 *  - it's the **same** algorithm the auth planes use for account passwords,
 *  - it's pure-JS scrypt (`@noble/hashes`), so it runs identically on Workers,
 *    Bun, Vercel and Netlify — no `node:crypto` / native scrypt dependency,
 *  - there's no new dependency: `better-auth` is already an auth-package dep.
 *
 * The stored format is better-auth's `"<salt-hex>:<key-hex>"` — 16-byte salt
 * (32 hex chars) and a 64-byte scrypt key (128 hex chars). {@link isSecretHash}
 * recognises it so an already-hashed value (a DB migration / restore feeding
 * pre-hashed rows) passes through the write path untouched instead of being
 * double-hashed.
 */

/** better-auth scrypt output: `<32 hex salt>:<128 hex key>`. */
const SECRET_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

/** True when `value` is already in the stored scrypt-digest format. */
export const isSecretHash = (value: string): boolean => SECRET_HASH_RE.test(value);

/** Scrypt-hash a plaintext secret into the stored `salt:key` digest. */
export const hashSecret = (plaintext: string): Promise<string> =>
  hashPassword(plaintext);

/**
 * Constant-time-ish verify of a plaintext against a stored digest. Returns
 * `false` (never throws) on a malformed/empty stored hash so a corrupt row
 * can't 500 the verify endpoint or leak "this hash is malformed" as a signal.
 */
export const verifySecret = async (
  plaintext: string,
  storedHash: string,
): Promise<boolean> => {
  if (!storedHash || !isSecretHash(storedHash)) return false;
  try {
    return await verifyPassword({ hash: storedHash, password: plaintext });
  } catch {
    return false;
  }
};
