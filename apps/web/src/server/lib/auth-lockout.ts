/**
 * Failed-login account lockout — two backends, picked at runtime, mirroring
 * `rate-limit.ts`:
 *
 * - **Durable Object** (Cloudflare Workers): when `env.RATE_LIMIT` is bound the
 *   lockout state for a key lives in its own `RateLimitRoom` instance, so the
 *   count is authoritative across isolates (an attacker can't reset it by
 *   scattering attempts over isolates).
 * - **In-memory** (Bun self-host, Vercel/Netlify Edge, tests): a module-level
 *   Map. Per-process, a coarse backstop — same trade-off the IP limiter makes.
 *
 * The transition logic lives once in `lockout-core.ts` and is shared by both
 * backends. All functions fail OPEN (return "not locked") on any backend error
 * — lockout is defense-in-depth, never the gate that bricks sign-in.
 */
import type { Env } from "../env";
import {
  applyFailure,
  evalLock,
  lockExpiry,
  type LockPolicy,
  type LockResult,
  type LockState,
} from "./lockout-core";

const NOT_LOCKED: LockResult = { locked: false, retryAfterMs: 0, remaining: -1, justLocked: false };

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Deployment-tunable lockout policy (env, with sane defaults). */
export const lockoutPolicy = (env: Env): LockPolicy => ({
  maxFails: num(env.AUTH_LOCKOUT_MAX_FAILS, 8),
  windowMs: num(env.AUTH_LOCKOUT_WINDOW_MS, 15 * 60_000),
  baseCooldownMs: num(env.AUTH_LOCKOUT_COOLDOWN_MS, 60_000),
  maxCooldownMs: num(env.AUTH_LOCKOUT_MAX_COOLDOWN_MS, 15 * 60_000),
});

/** Off-switch — lockout is on by default. */
export const lockoutEnabled = (env: Env): boolean => env.AUTH_LOCKOUT_DISABLED !== "true";

// ── In-memory backend ────────────────────────────────────────────────────────

const mem = new Map<string, LockState>();

const memGc = (now: number): void => {
  if (mem.size <= 5_000) return;
  for (const [k, v] of mem) {
    // Drop entries whose lock has lifted and whose window is long stale.
    if (v.lockedUntil <= now && now - v.windowStart > 60 * 60_000) mem.delete(k);
  }
};

// ── DO backend ───────────────────────────────────────────────────────────────

const doCall = async (
  ns: DurableObjectNamespace,
  key: string,
  path: string,
  body: unknown,
): Promise<LockResult | null> => {
  try {
    const stub = ns.get(ns.idFromName(`lock:${key}`));
    const res = await stub.fetch(
      new Request(`https://rate-limit/lock/${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),
    );
    if (!res.ok) return null;
    return (await res.json()) as LockResult;
  } catch {
    return null;
  }
};

// ── Public API ───────────────────────────────────────────────────────────────

/** Is `key` (an identifier, e.g. `signin:<email>`) currently locked? Read-only. */
export const checkLocked = async (env: Env, key: string): Promise<LockResult> => {
  if (env.RATE_LIMIT) {
    return (await doCall(env.RATE_LIMIT, key, "check", {})) ?? NOT_LOCKED;
  }
  return evalLock(mem.get(key), Date.now());
};

/** Record one failed attempt for `key`; returns the resulting lock state. */
export const recordFailure = async (
  env: Env,
  key: string,
  policy: LockPolicy,
): Promise<LockResult> => {
  if (env.RATE_LIMIT) {
    return (await doCall(env.RATE_LIMIT, key, "fail", { policy })) ?? NOT_LOCKED;
  }
  const now = Date.now();
  const { state, result } = applyFailure(mem.get(key), now, policy);
  mem.set(key, state);
  memGc(now);
  return result;
};

/** Clear `key`'s failure record after a successful sign-in. */
export const clearFailures = async (env: Env, key: string): Promise<void> => {
  if (env.RATE_LIMIT) {
    await doCall(env.RATE_LIMIT, key, "clear", {});
    return;
  }
  mem.delete(key);
};

export { lockExpiry };
export type { LockPolicy, LockResult };
