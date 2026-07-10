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

/** Full result of a limiter check. `remaining`/`resetAt` feed the IETF-draft
 *  `RateLimit-*` response headers so clients can back off predictively. */
export interface RateLimitResult {
  allowed: boolean;
  /** Calls left in the current window after this one (0 when rejected). */
  remaining: number;
  /** Epoch ms at which the current window resets. */
  resetAt: number;
  /** The `max` budget echoed back, for `RateLimit-Limit`. */
  limit: number;
}

const localWindows = new Map<string, { count: number; resetAt: number }>();

const checkLocal = (
  key: string,
  max: number,
  windowMs: number,
): RateLimitResult => {
  const now = Date.now();
  const w = localWindows.get(key);
  if (!w || w.resetAt <= now) {
    // Opportunistic GC so the map doesn't grow unbounded with stale keys.
    if (localWindows.size > 5_000) {
      for (const [k, v] of localWindows) if (v.resetAt <= now) localWindows.delete(k);
    }
    const resetAt = now + windowMs;
    localWindows.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: Math.max(0, max - 1), resetAt, limit: max };
  }
  if (w.count >= max)
    return { allowed: false, remaining: 0, resetAt: w.resetAt, limit: max };
  w.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, max - w.count),
    resetAt: w.resetAt,
    limit: max,
  };
};

const checkDurable = async (
  ns: DurableObjectNamespace,
  key: string,
  max: number,
  windowMs: number,
): Promise<RateLimitResult> => {
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
      return { allowed: true, remaining: Math.max(0, max - 1), resetAt: Date.now() + windowMs, limit: max };
    }
    const body = (await res.json()) as {
      allowed: boolean;
      remaining: number;
      resetAt: number;
    };
    return {
      allowed: body.allowed,
      remaining: Math.max(0, body.remaining),
      resetAt: body.resetAt,
      limit: max,
    };
  } catch {
    // Network glitch / DO transient — same fail-open policy as above.
    return { allowed: true, remaining: Math.max(0, max - 1), resetAt: Date.now() + windowMs, limit: max };
  }
};

/**
 * Check the `(max, windowMs)` budget for `key` and return the full window
 * state (allowed + remaining + resetAt). Always pass the request `env` — the DO
 * binding is read from it on Workers. Tests + Bun runtimes use the in-memory
 * fallback transparently.
 */
export const rateLimitCheck = async (
  env: Env,
  key: string,
  max: number,
  windowMs: number,
): Promise<RateLimitResult> => {
  if (env.RATE_LIMIT) {
    return checkDurable(env.RATE_LIMIT, key, max, windowMs);
  }
  return checkLocal(key, max, windowMs);
};

/** Last authoritative DO answer per key — the deferred limiter's verdict
 *  source. Refreshed in the background on every deferred check. */
const durableSnapshots = new Map<string, RateLimitResult>();

/**
 * Non-blocking variant of {@link rateLimitCheck} for the hot data path.
 *
 * The blocking check costs a DO round-trip on EVERY gated request — traced at
 * ~75ms of an ~87ms warm `/api/items/*` handler, the single largest latency
 * item on the instance hot path. For the deliberately generous global API
 * quota that precision isn't worth the latency, so this variant:
 *
 *   - answers immediately from the last authoritative DO snapshot (with the
 *     per-isolate window as a local bound / first-call fallback), and
 *   - counts this request + refreshes the snapshot off the critical path via
 *     `defer` (wire it to `executionCtx.waitUntil` on Workers).
 *
 * Semantics: eventually consistent. A burst can overshoot by the requests in
 * flight during one DO round-trip before verdicts converge — acceptable for a
 * runaway-workload guard (the fixed window already tolerates ~2× at boundary
 * straddles). NOT for the auth / brute-force limiters: those must stay on the
 * blocking {@link rateLimitCheck} so the verdict is authoritative BEFORE any
 * credential work runs.
 */
export const rateLimitCheckDeferred = (
  env: Env,
  key: string,
  max: number,
  windowMs: number,
  defer: (work: Promise<unknown>) => void,
): RateLimitResult => {
  const ns = env.RATE_LIMIT;
  if (!ns) return checkLocal(key, max, windowMs);

  // Local estimate: bounds a single-isolate burst and supplies remaining /
  // resetAt until the first snapshot lands.
  const local = checkLocal(key, max, windowMs);

  defer(
    checkDurable(ns, key, max, windowMs).then((r) => {
      // Opportunistic GC, same pattern as `localWindows` above.
      if (durableSnapshots.size > 5_000) {
        const now = Date.now();
        for (const [k, v] of durableSnapshots)
          if (v.resetAt <= now) durableSnapshots.delete(k);
      }
      durableSnapshots.set(key, r);
    }),
  );

  const snap = durableSnapshots.get(key);
  if (snap && snap.resetAt > Date.now()) {
    // The DO declared the window exhausted → block until it resets. A
    // `remaining` of 0 on an allowed answer means the NEXT call is over
    // budget, which is exactly this one.
    if (!snap.allowed || snap.remaining <= 0) {
      return { allowed: false, remaining: 0, resetAt: snap.resetAt, limit: max };
    }
    // Report the tighter of the two estimates so clients back off early.
    return snap.remaining < local.remaining ? { ...snap, limit: max } : local;
  }
  // No snapshot yet (or it expired with the window) — fail open on the local
  // verdict, mirroring the DO-unhealthy policy in `checkDurable`.
  return local;
};

/**
 * Returns true if the call is within the `(max, windowMs)` budget for `key`.
 * Thin boolean wrapper over {@link rateLimitCheck} for callers that don't need
 * the window metadata (the auth limiter, per-route IP guards).
 */
export const rateLimitOk = async (
  env: Env,
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> => (await rateLimitCheck(env, key, max, windowMs)).allowed;
