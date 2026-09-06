import type { PushAdapter, PushMessage, PushSendResult } from "@backlex/core/adapters";
import { encryptWebPush, importVapidKey, signJwt } from "../lib/push-crypto";
import { isPrivateHost } from "../services/storage/hosts";

/** Endpoint must be https + a public host. Registration already enforces this,
 *  but re-check at send time as defense-in-depth against DNS rebinding and rows
 *  that predate the registration guard. */
const isSafeEndpoint = (endpoint: string): boolean => {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !isPrivateHost(u.hostname);
  } catch {
    return false;
  }
};

/**
 * Web Push (browsers) with VAPID auth and `aes128gcm` payload encryption
 * (RFC 8291). Each `web-push` token carries the endpoint URL in `token` and the
 * subscription `keys` ({ p256dh, auth }); a token without keys can't be
 * encrypted for and is reported invalid. Fully fetch-based — runs on every
 * runtime including Cloudflare Workers.
 */

interface WebPushConfig {
  /** VAPID `subject` — a `mailto:` or origin URL identifying the sender. */
  subject: string;
  /** VAPID public key (base64url, raw uncompressed P-256 point). */
  vapidPublicKey: string;
  /** VAPID private key (PKCS8 PEM, EC P-256). */
  vapidPrivateKey: string;
}

/**
 * Build the VAPID `Authorization` header for an endpoint's origin (per-origin
 * JWT, cached for the token's ~12h lifetime).
 *
 * Both caches are keyed by the VAPID IDENTITY, not just the endpoint origin.
 * They were not, and on a multi-workspace deployment that made them wrong in
 * two compounding ways: `vapidCache` keyed on `aud` alone handed workspace B
 * the header workspace A minted for the same push service, and the single
 * `let vapidKey` pinned the FIRST config's private key for the life of the
 * isolate — so B's header advertised `k=<B's public key>` over a signature made
 * with A's private one. A browser push service validates that pair against the
 * subscription's `applicationServerKey` and answers 403, meaning one
 * workspace's web push went dark for as long as the isolate lived, with no
 * error anywhere on the send path.
 *
 * `vapidPublicKey` identifies the keypair and `subject` is asserted in the
 * `sub` claim, so both belong in the header's key; the private key never does.
 * Capped like every other per-isolate map here — see `push.apns.ts`.
 */
const vapidCache = new Map<string, { header: string; exp: number }>();
const vapidKeys = new Map<string, Promise<CryptoKey>>();
const VAPID_CACHE_CAP = 500;

const vapidHeader = async (cfg: WebPushConfig, endpoint: string): Promise<string> => {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const identity = `${cfg.vapidPublicKey}|${cfg.subject}`;
  const key = `${identity}|${aud}`;
  const cached = vapidCache.get(key);
  if (cached && cached.exp - 300 > now) return cached.header;
  const exp = now + 12 * 3600;
  let signingKey = vapidKeys.get(identity);
  if (!signingKey) {
    // Drop a rejected import rather than memoizing the failure: an unparseable
    // key is worth reporting once per send, not once per isolate.
    signingKey = importVapidKey(cfg.vapidPrivateKey, cfg.vapidPublicKey).catch(
      (e: unknown) => {
        vapidKeys.delete(identity);
        throw e;
      },
    );
    if (vapidKeys.size >= VAPID_CACHE_CAP) vapidKeys.clear();
    vapidKeys.set(identity, signingKey);
  }
  const jwt = await signJwt({}, { aud, exp, sub: cfg.subject }, await signingKey, "ES256");
  const header = `vapid t=${jwt}, k=${cfg.vapidPublicKey}`;
  if (vapidCache.size >= VAPID_CACHE_CAP) vapidCache.clear();
  vapidCache.set(key, { header, exp });
  return header;
};

export const webPush = (cfg: WebPushConfig): PushAdapter => ({
  async send(msg: PushMessage): Promise<PushSendResult> {
    const targets = msg.tokens.filter((t) => t.platform === "web-push");
    if (targets.length === 0) return { sent: 0, failed: 0, invalidTokens: [] };

    const payload = JSON.stringify({
      title: msg.title,
      body: msg.body,
      url: msg.url,
      icon: msg.icon,
      badge: msg.badge,
      data: msg.data,
    });
    const result: PushSendResult = { sent: 0, failed: 0, invalidTokens: [] };

    await Promise.all(
      targets.map(async (t) => {
        if (!t.keys?.p256dh || !t.keys?.auth) {
          result.failed++;
          result.invalidTokens.push(t.token);
          return;
        }
        if (!isSafeEndpoint(t.token)) {
          // Refuse to fetch a non-public/non-https endpoint (SSRF guard) and
          // prune the offending registration.
          result.failed++;
          result.invalidTokens.push(t.token);
          return;
        }
        try {
          const body = await encryptWebPush(payload, t.keys.p256dh, t.keys.auth);
          const res = await fetch(t.token, {
            method: "POST",
            headers: {
              authorization: await vapidHeader(cfg, t.token),
              "content-encoding": "aes128gcm",
              "content-type": "application/octet-stream",
              ttl: "2419200",
            },
            body: body as unknown as BodyInit,
          });
          if (res.ok || res.status === 201) {
            result.sent++;
            return;
          }
          result.failed++;
          // 404/410 → subscription gone; prune it.
          if (res.status === 404 || res.status === 410) result.invalidTokens.push(t.token);
        } catch {
          result.failed++;
        }
      }),
    );
    return result;
  },
});
