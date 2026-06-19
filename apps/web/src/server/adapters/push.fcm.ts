import type { PushAdapter, PushMessage, PushSendResult } from "@backlex/core/adapters";
import { signJwt } from "../lib/push-crypto";

/**
 * Firebase Cloud Messaging via the HTTP v1 API. Auth is a short-lived OAuth2
 * access token minted from the service-account key (RS256 JWT → token
 * endpoint), cached in-process until ~60s before expiry. Handles only `fcm`
 * tokens; a mixed batch is filtered by the composite adapter upstream.
 */

interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** Service-account `private_key` (PKCS8 PEM, RSA). */
  privateKey: string;
}

const tokenCache = new Map<string, { token: string; exp: number }>();

const getAccessToken = async (cfg: FcmConfig): Promise<string> => {
  const cached = tokenCache.get(cfg.clientEmail);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const jwt = await signJwt(
    {},
    {
      iss: cfg.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    cfg.privateKey,
    "RS256",
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) {
    throw new Error(`fcm: token exchange ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(cfg.clientEmail, { token: json.access_token, exp: now + json.expires_in });
  return json.access_token;
};

export const fcmPush = (cfg: FcmConfig): PushAdapter => ({
  async send(msg: PushMessage): Promise<PushSendResult> {
    const targets = msg.tokens.filter((t) => t.platform === "fcm");
    if (targets.length === 0) return { sent: 0, failed: 0, invalidTokens: [] };

    const accessToken = await getAccessToken(cfg);
    const url = `https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`;
    const result: PushSendResult = { sent: 0, failed: 0, invalidTokens: [] };

    await Promise.all(
      targets.map(async (t) => {
        const message: Record<string, unknown> = {
          token: t.token,
          notification: { title: msg.title, body: msg.body },
        };
        if (msg.data) message.data = msg.data;
        if (msg.url || msg.icon) {
          message.webpush = {
            notification: { icon: msg.icon },
            fcm_options: msg.url ? { link: msg.url } : undefined,
          };
        }
        const res = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ message }),
        });
        if (res.ok) {
          result.sent++;
          return;
        }
        result.failed++;
        // 404 UNREGISTERED / 400 INVALID_ARGUMENT → token is permanently dead.
        if (res.status === 404 || res.status === 400) {
          result.invalidTokens.push(t.token);
        }
      }),
    );
    return result;
  },
});
