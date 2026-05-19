/**
 * Fixed-window rate limiter.
 *
 * Two backends, picked at runtime:
 *
 * - **Durable Object** (Cloudflare Workers): when `env.RATE_LIMIT` is bound,
 *   each call dispatches to a per-key `RateLimitRoom` so the count is shared
 *   across every isolate Cloudflare may spin up. This is the production path
 *   — without it the in-memory limiter is bypassable by simply distributing
 *   requests over enough isolates (which the runtime spawns at colo scale).
 * - **In-memory** (Bun self-host, Vercel/Netlify Edge, tests): module-level
 *   Map keyed on the same string. Per-process, not distributed — enough to
 *   blunt accidental floods on a single process, which is the only attack
 *   surface those runtimes expose.
 *
 * Returns `true` when the call is allowed, `false` when the window is
 * exhausted. The window is *fixed*, not sliding — count rolls over the instant
 * `resetAt` passes, so worst case a client gets `2 × max` requests inside a
 * brief boundary-straddle. That matches the previous semantics; tighter
 * guarantees would need a token bucket.
 */
import type { Env } from "../env";

const localWindows = new Map<string, { count: number; resetAt: number }>();

const checkLocal = (key: string, max: number, windowMs: number): boolean => {
  const now = Date.now();
  const w = localWindows.get(key);
  if (!w || w.resetAt <= now) {
    // Opportunistic GC so the map doesn't grow unbounded with stale keys.
    if (localWindows.size > 5_000) {
      for (const [k, v] of localWindows) if (v.resetAt <= now) localWindows.delete(k);
    }
    localWindows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (w.count >= max) return false;
  w.count += 1;
  return true;
};

const checkDurable = async (
  ns: DurableObjectNamespace,
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> => {
  const id = ns.idFromName(key);
  const stub = ns.get(id);
  try {
    const res = await stub.fetch(
      new Request("https://rate-limit/check", {
        method: "POST",
        body: JSON.stringify({ max, windowMs }),
      }),
    );
    if (!res.ok) {
      // DO unhealthy — fail open. Rate limiting is a defense-in-depth layer,
      // not the only gate; better to let a brief spike through than to lock
      // every user out because the DO is misbehaving.
      return true;
    }
    const body = (await res.json()) as { allowed: boolean };
    return body.allowed;
  } catch {
    // Network glitch / DO transient — same fail-open policy as above.
    return true;
  }
};

/**
 * Returns true if the call is within the `(max, windowMs)` budget for `key`.
 * Always pass the request `env` — the DO binding is read from it on Workers.
 * Tests + Bun runtimes work with the in-memory fallback transparently.
 */
export const rateLimitOk = async (
  env: Env,
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> => {
  if (env.RATE_LIMIT) {
    return checkDurable(env.RATE_LIMIT, key, max, windowMs);
  }
  return checkLocal(key, max, windowMs);
};
