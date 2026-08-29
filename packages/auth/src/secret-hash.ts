import { hashPassword, verifyPassword } from "@better-auth/utils/password";

/**
 * One-way secret hashing for `hash`-typed collection fields (passwords, PINs,
 * API secrets, …). Reuses better-auth's own scrypt primitives so:
 *
 *  - it's the **same** algorithm the auth planes use for account passwords,
 *  - it's the same module better-auth itself reaches, resolved through the same
 *    export conditions — `node:crypto` scrypt on Workers/Node/Bun, the
 *    `@noble/hashes` pure-JS fallback elsewhere. Identical `N=16384, r=16, p=1,
 *    dkLen=64` either way, so a digest written on one runtime verifies on
 *    another.
 *
 * It imports `@better-auth/utils/password` DIRECTLY rather than `better-auth/
 * crypto`, and that is a startup-cost decision, not a style one. `better-auth/
 * crypto`'s index re-exports its JWT and symmetric-encryption helpers as well,
 * which drags `jose` and `@noble/ciphers` — ~160 KiB — into the worker's EAGER
 * graph for a module that only ever wanted scrypt. `crypto/index.mjs` has no
 * deeper subpath in better-auth's `exports` map, so the leaf has to be reached
 * at its own package. `better-auth/crypto`'s `password.mjs` is a five-line
 * wrapper over exactly this import; the only difference is the call shape,
 * which is positional here and an object there.
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
    return await verifyPassword(storedHash, plaintext);
  } catch {
    return false;
  }
};
