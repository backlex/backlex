import type { PushAdapter, PushMessage, PushSendResult } from "@backlex/core/adapters";
import { encryptWebPush, signJwt } from "../lib/push-crypto";

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

/** Build the VAPID `Authorization` header for an endpoint's origin (per-origin
 *  JWT, cached for the token's ~12h lifetime). */
const vapidCache = new Map<string, { header: string; exp: number }>();

const vapidHeader = async (cfg: WebPushConfig, endpoint: string): Promise<string> => {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const cached = vapidCache.get(aud);
  if (cached && cached.exp - 300 > now) return cached.header;
  const exp = now + 12 * 3600;
  const jwt = await signJwt(
    {},
    { aud, exp, sub: cfg.subject },
    cfg.vapidPrivateKey,
    "ES256",
  );
  const header = `vapid t=${jwt}, k=${cfg.vapidPublicKey}`;
  vapidCache.set(aud, { header, exp });
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
