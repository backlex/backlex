/**
 * Request pacing for providers that publish a quota.
 *
 * The breaker in the sync service counts consecutive *failures*, which is the
 * right instrument for "this integration is broken" and the wrong one for "this
 * provider is telling us to slow down". A marketplace that allows a handful of
 * requests a second answers a page walk with 429s, and without the two being
 * told apart a perfectly healthy connection pauses itself after five runs.
 *
 * So there are two halves here, and both are needed:
 *
 *   - a **token bucket** that spaces requests out before they are made, so the
 *     common case never earns a 429 in the first place;
 *   - {@link RateLimitedError}, thrown when a provider says 429 anyway, so the
 *     engine can hold the cursor without feeding the breaker.
 *
 * **The bucket is per-isolate and best-effort.** It paces the requests made by
 * the code sharing its memory — which is the run doing 20 pages of paging, the
 * case that actually earns a 429. Two isolates running two syncs against one
 * provider do not see each other, and no in-memory structure could make them.
 * That is why the 429 path is not a fallback but the actual guarantee: the
 * bucket keeps a single run polite, and Retry-After keeps the system correct.
 *
 * Pure + dependency-free, like the rest of this package: no DB, no env.
 */

import type { FetchLike, RateLimit } from "./provider";

/**
 * A provider answered 429.
 *
 * Distinct from an ordinary failure so the engine can hold the cursor and
 * reschedule without counting it against the breaker. `retryAfterMs` is the
 * provider's own Retry-After when it sent one — believe it rather than guessing,
 * because guessing shorter is what turns one 429 into a stream of them.
 */
export class RateLimitedError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Is this (or anything it wraps) a rate-limit refusal? */
export const isRateLimited = (e: unknown): e is RateLimitedError =>
  e instanceof RateLimitedError ||
  (e instanceof Error && e.cause instanceof RateLimitedError);

/**
 * Parse Retry-After, which RFC 9110 allows in two forms: delta-seconds, or an
 * HTTP-date. Both appear in the wild — Trendyol sends seconds, some CDNs in
 * front of carrier APIs send a date.
 *
 * Anything unparseable, negative, or absurd returns `null` so the caller falls
 * back to its own backoff rather than sleeping on a garbage value. The cap is
 * five minutes: a longer wait belongs to the job scheduler, not to a held-open
 * request.
 */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const raw = header.trim();
  if (!raw) return null;

  // delta-seconds
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return ms >= 0 && ms <= MAX_RETRY_AFTER_MS ? ms : null;
  }

  // HTTP-date
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const ms = at - nowMs;
  if (ms <= 0) return 0;
  return ms <= MAX_RETRY_AFTER_MS ? ms : null;
}

/** One provider's bucket. Refilled lazily — no timers, nothing to clean up. */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
  /**
   * Serialises waiters. Without it, ten concurrent callers all read the same
   * token count, all decide there is room, and the pacing does nothing.
   */
  tail: Promise<void>;
}

const buckets = new Map<string, Bucket>();

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/**
 * Wait until this key's bucket has a token, then take it.
 *
 * Exported for the tests; callers normally reach it through {@link throttled}.
 */
export async function takeToken(key: string, limit: RateLimit): Promise<void> {
  const now = Date.now;
  const capacity = Math.max(1, limit.burst ?? Math.ceil(limit.rps));
  const refillPerMs = limit.rps / 1000;

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefillMs: now(), tail: Promise.resolve() };
    buckets.set(key, bucket);
  }
  const b = bucket;

  // Chain onto the tail so concurrent callers queue instead of racing on the
  // same token count. Each link resolves once ITS token has been taken.
  const wait = b.tail.then(async () => {
    for (;;) {
      const t = now();
      const elapsed = Math.max(0, t - b.lastRefillMs);
      b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerMs);
      b.lastRefillMs = t;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return;
      }
      await sleep(Math.ceil((1 - b.tokens) / refillPerMs));
    }
  });
  // Swallow on the stored tail only: a rejection must not orphan the queue, but
  // the caller still sees it through `wait`.
  b.tail = wait.then(
    () => undefined,
    () => undefined,
  );
  return wait;
}

/** Drop all pacing state. Tests only — each spec starts from an empty bucket. */
export function resetThrottleState(): void {
  buckets.clear();
}

/**
 * Wrap a fetch so it paces itself and reports 429 as {@link RateLimitedError}.
 *
 * `key` namespaces the bucket. It is the provider kind plus the connection id,
 * not the kind alone: two workspaces holding two different sellers' credentials
 * have two independent quotas at the provider, and pacing them against each
 * other would halve the throughput each of them paid for.
 *
 * A provider that declares no limit is returned unwrapped except for the 429
 * classification — every provider benefits from that half, including the
 * thirty-odd that predate this.
 */
export function throttled(key: string, limit: RateLimit | undefined, inner: FetchLike): FetchLike {
  return async (input, init) => {
    if (limit) await takeToken(key, limit);
    const res = await inner(input, init);
    if (res.status === 429) {
      throw new RateLimitedError(
        "Provider rate limit reached (HTTP 429)",
        parseRetryAfter(res.headers.get("retry-after"), Date.now()),
      );
    }
    return res;
  };
}
