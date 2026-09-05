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
    buf(new TextEncoder().encode(`backlex:auth-config-secret:v1:${secret}`)),
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

// ---------------------------------------------------------------------------
// HMAC URL signing (storage signed URLs)
// ---------------------------------------------------------------------------

const b64urlEncode = (bytes: Uint8Array): string =>
  b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return b64decode(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
};

/**
 * Derive an HMAC key from a shared secret, domain-separated by `purpose`.
 *
 * The purpose string is part of the digested material, so a signature minted
 * for one purpose can never verify as another even though both derive from the
 * same deployment secret — a storage URL is not a sandbox grant.
 */
const deriveHmacKey = async (
  secret: string,
  purpose = "storage-url-sign",
): Promise<CryptoKey> => {
  const material = await crypto.subtle.digest(
    "SHA-256",
    buf(new TextEncoder().encode(`backlex:${purpose}:v1:${secret}`)),
  );
  return crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
};

export interface StorageUrlPayload {
  /** Physical key (already tenant-prefixed). */
  k: string;
  /** Tenant id — pinned so a leaked token only unlocks one workspace. */
  t: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

/** Produce `<base64url-payload>.<base64url-sig>` for the storage GET route. */
export const signStorageUrl = async (
  payload: StorageUrlPayload,
  secret: string,
): Promise<string> => {
  const key = await deriveHmacKey(secret);
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      buf(new TextEncoder().encode(body)),
    ),
  );
  return `${body}.${b64urlEncode(sig)}`;
};

/**
 * Validate a token produced by {@link signStorageUrl}. Returns the payload
 * when the signature is intact AND the token hasn't expired; `null` on any
 * failure (malformed, bad signature, expired). Never throws — callers gate
 * on the return value.
 */
export const verifyStorageUrl = async (
  token: string,
  secret: string,
): Promise<StorageUrlPayload | null> => {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await deriveHmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      buf(b64urlDecode(sig)),
      buf(new TextEncoder().encode(body)),
    );
    if (!ok) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(body)),
    ) as StorageUrlPayload;
    if (
      typeof payload.k !== "string" ||
      typeof payload.t !== "string" ||
      typeof payload.exp !== "number"
    ) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Sandbox RPC grants (the out-of-isolate function executor's callback identity)
// ---------------------------------------------------------------------------

const GRANT_PURPOSE = "sandbox-rpc-grant";

/**
 * Who a sandboxed function is running as, stated by the main app rather than
 * by the executor.
 *
 * The executor is a SOFT sandbox running user-authored code (its own header
 * says so), so anything it hands back is attacker-controlled: before this
 * existed, `/api/_internal/sandbox-rpc` read the subject out of the request
 * BODY and the shared bearer token was the only thing standing behind it. A
 * function author who reached the token — trivial in-process, e.g. by wrapping
 * `globalThis.fetch` and reading the Authorization header off the executor's
 * own next callback — could then name any workspace.
 *
 * So the claim travels signed. The main app mints one of these per invocation
 * and puts it in the `/run` body's `rpcToken`, which the executor already
 * echoes back verbatim as its bearer; the callback derives the subject from
 * the verified token and ignores the body's `auth` entirely. The executor never
 * receives `SANDBOX_RPC_TOKEN` itself, so it cannot leak what it does not hold,
 * and a stolen grant is worth only the invocation it was minted for.
 */
export interface SandboxGrantPayload {
  /** Subject user id. `null` for a trigger with nobody signed in (cron). */
  u: string | null;
  /** Subject email, for `ctx.user`. */
  e: string | null;
  /** Role names the subject held when the invocation started. */
  r: string[];
  /** Workspace the invocation belongs to. `null` outside a workspace. */
  t: string | null;
  /** Expiry, epoch seconds. */
  exp: number;
}

/** Mint a grant for one invocation. Same `<payload>.<sig>` shape as the
 *  storage URL token, keyed by `SANDBOX_RPC_TOKEN`. */
export const signSandboxGrant = async (
  payload: SandboxGrantPayload,
  secret: string,
): Promise<string> => {
  const key = await deriveHmacKey(secret, GRANT_PURPOSE);
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, buf(new TextEncoder().encode(body))),
  );
  return `${body}.${b64urlEncode(sig)}`;
};

/**
 * Validate a grant produced by {@link signSandboxGrant}. Returns the claims
 * when the signature is intact AND the grant hasn't expired; `null` on any
 * failure. Never throws — the callback route gates on the return value and
 * falls back to the legacy shared-secret comparison when this answers null.
 */
export const verifySandboxGrant = async (
  token: string,
  secret: string,
): Promise<SandboxGrantPayload | null> => {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await deriveHmacKey(secret, GRANT_PURPOSE);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      buf(b64urlDecode(sig)),
      buf(new TextEncoder().encode(body)),
    );
    if (!ok) return null;
    const p = JSON.parse(
      new TextDecoder().decode(b64urlDecode(body)),
    ) as SandboxGrantPayload;
    if (typeof p.exp !== "number" || !Array.isArray(p.r)) return null;
    if (p.u !== null && typeof p.u !== "string") return null;
    if (p.e !== null && typeof p.e !== "string") return null;
    if (p.t !== null && typeof p.t !== "string") return null;
    if (p.r.some((role) => typeof role !== "string")) return null;
    if (p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
};
