import type { PushAdapter, PushMessage, PushSendResult } from "@backlex/core/adapters";

/**
 * Fan a mixed-platform batch out to several leaf adapters and merge the
 * results. Each leaf already filters `msg.tokens` to the platforms it owns, so
 * we can hand every leaf the full message and sum what comes back. This is what
 * lets one deployment serve Android (fcm) + iOS (apns) + web (web-push) at once.
 */
export const multiPush = (leaves: PushAdapter[]): PushAdapter => ({
  async send(msg: PushMessage): Promise<PushSendResult> {
    const results = await Promise.all(leaves.map((a) => a.send(msg)));
    return results.reduce<PushSendResult>(
      (acc, r) => ({
        sent: acc.sent + r.sent,
        failed: acc.failed + r.failed,
        invalidTokens: [...acc.invalidTokens, ...r.invalidTokens],
      }),
      { sent: 0, failed: 0, invalidTokens: [] },
    );
  },
});
