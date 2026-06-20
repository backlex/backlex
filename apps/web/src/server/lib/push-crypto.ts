/**
 * Crypto primitives shared by the push adapters, all built on the Web Crypto
 * API (`crypto.subtle`) so they run unchanged on Cloudflare Workers, Bun, and
 * Node 18+ — no node:crypto, no native deps.
 *
 *  - FCM (HTTP v1)  → service-account JWT signed RS256, exchanged for an OAuth2
 *    access token.
 *  - APNs (token)   → provider JWT signed ES256 (P-256) from the .p8 key.
 *  - Web Push       → VAPID JWT signed ES256 + RFC 8291 `aes128gcm` payload
 *    encryption (ECDH P-256 → HKDF → AES-128-GCM).
 */

const enc = new TextEncoder();

export const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/** Decode a PEM ("-----BEGIN …-----" wrapped base64) body to raw DER bytes. */
const pemToDer = (pem: string): Uint8Array => {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const importRsaKey = (pem: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "pkcs8",
    buf(pemToDer(pem)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

const importEcKey = (pem: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "pkcs8",
    buf(pemToDer(pem)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

/**
 * Import a VAPID signing key from the standard `web-push generate-vapid-keys`
 * format — a raw base64url 32-byte private scalar plus the base64url public
 * point (0x04 || x || y). WebCrypto can't import a bare EC scalar, so we build
 * a JWK from `d` (private) + `x`/`y` (sliced out of the public point). This is
 * the format every web-push library emits — NOT a PKCS8 PEM.
 */
export const importVapidKey = (
  privateKeyB64url: string,
  publicKeyB64url: string,
): Promise<CryptoKey> => {
  const pub = b64urlToBytes(publicKeyB64url); // 65 bytes: 0x04 || x(32) || y(32)
  const x = b64url(pub.slice(1, 33));
  const y = b64url(pub.slice(33, 65));
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: privateKeyB64url, x, y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
};

/**
 * Sign a JWT (compact JWS). `key` is a PEM string (RS256 = FCM service account;
 * ES256 = APNs .p8) or a pre-imported CryptoKey (ES256 = VAPID via
 * {@link importVapidKey}, whose key isn't a PEM).
 */
export const signJwt = async (
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: string | CryptoKey,
  alg: "RS256" | "ES256",
): Promise<string> => {
  const head = b64url(enc.encode(JSON.stringify({ ...header, alg, typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const signingInput = `${head}.${body}`;
  const cryptoKey =
    typeof key === "string"
      ? alg === "RS256"
        ? await importRsaKey(key)
        : await importEcKey(key)
      : key;
  const params =
    alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  // subtle's ECDSA output is already raw r||s (JOSE format) — no DER unwrap.
  const sig = new Uint8Array(await crypto.subtle.sign(params, cryptoKey, enc.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
};

// ── Web Push payload encryption (RFC 8291, aes128gcm) ───────────────────────

const hkdf = async (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
};

const concat = (...arrs: Uint8Array[]): Uint8Array => {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
};

/**
 * Encrypt a UTF-8 payload for a web-push subscription using the `aes128gcm`
 * content-encoding (RFC 8291 / RFC 8188). `p256dh`/`auth` are the subscription
 * keys (base64url). Returns the binary body to POST to the endpoint.
 */
export const encryptWebPush = async (
  payload: string,
  p256dhB64: string,
  authB64: string,
): Promise<Uint8Array> => {
  const clientPub = b64urlToBytes(p256dhB64); // 65-byte uncompressed point
  const authSecret = b64urlToBytes(authB64);

  // Ephemeral server ECDH keypair.
  const serverKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));

  const clientKey = await crypto.subtle.importKey(
    "raw",
    buf(clientPub),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, serverKeys.privateKey, 256),
  );

  // PRK = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_pub || as_pub)
  const keyInfo = concat(
    enc.encode("WebPush: info\0"),
    clientPub,
    serverPubRaw,
  );
  const ikm = await hkdf(sharedSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", buf(cek), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  // Single record: plaintext || 0x02 delimiter (last record), no extra padding.
  const plaintext = concat(enc.encode(payload), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, aesKey, buf(plaintext)),
  );

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(serverPub).
  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // 4096
  const idlen = new Uint8Array([serverPubRaw.length]);
  return concat(salt, rs, idlen, serverPubRaw, ciphertext);
};
