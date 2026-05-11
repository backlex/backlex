/**
 * Fixed-window in-memory rate limiter.
 *
 * Per-isolate on Workers (and per-process on Bun) — not a hard distributed
 * quota, just enough to blunt accidental floods on the open realtime publish
 * endpoint. Returns `true` when the call is allowed, `false` when the window
 * is exhausted.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

export const rateLimitOk = (
  key: string,
  max: number,
  windowMs: number,
): boolean => {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    // Opportunistic GC so the map doesn't grow unbounded with stale keys.
    if (windows.size > 5_000) {
      for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
    }
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (w.count >= max) return false;
  w.count += 1;
  return true;
};
