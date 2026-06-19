import type { PushAdapter, PushMessage, PushSendResult } from "@backlex/core/adapters";
import { signJwt } from "../lib/push-crypto";

/**
 * Apple Push Notification service, token-based auth (provider JWT, ES256 from
 * the .p8 key). The JWT is reused across sends and refreshed ~every 40 min
 * (Apple rejects tokens older than 1h and throttles minting < 20 min apart).
 *
 * NOTE: APNs requires HTTP/2. `fetch` negotiates h2 transparently on Cloudflare
 * Workers, so direct APNs works there. On Node/Bun (undici, HTTP/1.1) the
 * request is refused — route iOS through FCM on those runtimes instead.
 */

interface ApnsConfig {
  /** Key ID of the .p8 (APNs Auth Key). */
  keyId: string;
  /** Apple Developer Team ID. */
  teamId: string;
  /** .p8 private key contents (PKCS8 PEM, EC P-256). */
  privateKey: string;
  /** App bundle id — sent as `apns-topic`. */
  bundleId: string;
  /** true → api.push.apple.com; false → sandbox. Defaults to production. */
  production?: boolean;
}

let cached: { jwt: string; exp: number } | null = null;

const providerJwt = async (cfg: ApnsConfig): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - (cached.exp - 3600) < 40 * 60) return cached.jwt;
  const jwt = await signJwt(
    { kid: cfg.keyId },
    { iss: cfg.teamId, iat: now },
    cfg.privateKey,
    "ES256",
  );
  cached = { jwt, exp: now + 3600 };
  return jwt;
};

export const apnsPush = (cfg: ApnsConfig): PushAdapter => ({
  async send(msg: PushMessage): Promise<PushSendResult> {
    const targets = msg.tokens.filter((t) => t.platform === "apns");
    if (targets.length === 0) return { sent: 0, failed: 0, invalidTokens: [] };

    const jwt = await providerJwt(cfg);
    const host = cfg.production === false
      ? "https://api.development.push.apple.com"
      : "https://api.push.apple.com";
    const aps: Record<string, unknown> = { alert: { title: msg.title, body: msg.body } };
    if (typeof msg.badge === "number") aps.badge = msg.badge;
    const body = JSON.stringify({ aps, ...(msg.data ?? {}), ...(msg.url ? { url: msg.url } : {}) });
    const result: PushSendResult = { sent: 0, failed: 0, invalidTokens: [] };

    await Promise.all(
      targets.map(async (t) => {
        try {
          const res = await fetch(`${host}/3/device/${t.token}`, {
            method: "POST",
            headers: {
              authorization: `bearer ${jwt}`,
              "apns-topic": cfg.bundleId,
              "apns-push-type": "alert",
            },
            body,
          });
          if (res.ok) {
            result.sent++;
            return;
          }
          result.failed++;
          // 410 Unregistered, or 400 BadDeviceToken → prune.
          if (res.status === 410) {
            result.invalidTokens.push(t.token);
          } else if (res.status === 400) {
            const reason = (await res.json().catch(() => ({}))) as { reason?: string };
            if (reason.reason === "BadDeviceToken" || reason.reason === "DeviceTokenNotForTopic") {
              result.invalidTokens.push(t.token);
            }
          }
        } catch {
          result.failed++;
        }
      }),
    );
    return result;
  },
});
