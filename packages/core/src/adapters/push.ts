/**
 * Push-notification transport. Mirrors the EmailAdapter shape, with two
 * push-specific differences:
 *  - a message targets a *set* of device tokens (not a single address), and
 *    those tokens may span platforms — the adapter sends to the tokens whose
 *    platform it handles and ignores the rest (a composite adapter fans a mixed
 *    batch out to the right per-platform leaf);
 *  - `send` returns a result so the caller can prune tokens the provider
 *    reported as permanently invalid (push tokens expire; email addresses do
 *    not).
 */

export type PushPlatform = "fcm" | "apns" | "web-push";

export interface PushToken {
  platform: PushPlatform;
  /** FCM registration token, APNs device token, or web-push endpoint URL. */
  token: string;
  /** web-push only: VAPID subscription keys ({ p256dh, auth }). */
  keys?: { p256dh: string; auth: string };
}

export interface PushMessage {
  /** Target devices. Adapters process only the tokens for platforms they own. */
  tokens: PushToken[];
  title: string;
  body: string;
  /** Deep-link / click-through URL opened when the notification is tapped. */
  url?: string;
  /** Arbitrary string payload delivered to the client handler. */
  data?: Record<string, string>;
  /** Small icon / image URL (web-push, FCM). */
  icon?: string;
  /** Badge count (APNs, web). */
  badge?: number;
}

export interface PushSendResult {
  /** Number of tokens the provider accepted for delivery. */
  sent: number;
  /** Number of tokens that failed for a transient/unknown reason. */
  failed: number;
  /**
   * Tokens the provider rejected as permanently invalid (unregistered /
   * expired). The caller should deactivate these in `device_tokens`.
   */
  invalidTokens: string[];
}

export interface PushAdapter {
  send(msg: PushMessage): Promise<PushSendResult>;
}
