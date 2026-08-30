import type { PushAdapter, PushMessage, PushSendResult } from "@backlex/core/adapters";

/**
 * Fan a mixed-platform batch out to several leaf adapters and merge the
 * results. Each leaf already filters `msg.tokens` to the platforms it owns, so
 * we can hand every leaf the full message and sum what comes back. This is what
 * lets one deployment serve Android (fcm) + iOS (apns) + web (web-push) at once.
 */
export const multiPush = (leaves: PushAdapter[]): PushAdapter => ({
  async send(msg: PushMessage): Promise<PushSendResult> {
    // `allSettled`, not `all`. A leaf that THROWS — a bug, a null deref, a
    // provider SDK that raises instead of returning — would otherwise reject
    // the whole fan-out, and the other platforms' pushes have already gone out
    // by then. The caller would see an exception, record a total failure for a
    // partly-delivered send, and a retry would re-notify every device that
    // already got it.
    //
    // A rejected leaf contributes nothing to the counts rather than a guessed
    // failure total: this aggregator does not know which platform a leaf owns,
    // so it cannot say how many tokens went unanswered. Reporting them as
    // `failed` would be inventing a number; leaving them unaccounted is the
    // same shape as a token whose platform has no leaf at all, which this
    // adapter already declines to count.
    const settled = await Promise.allSettled(leaves.map((a) => a.send(msg)));
    const results = settled
      .filter((r): r is PromiseFulfilledResult<PushSendResult> => r.status === "fulfilled")
      .map((r) => r.value);
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
