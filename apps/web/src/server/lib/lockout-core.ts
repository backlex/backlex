/**
 * Pure state machine for failed-login account lockout. Shared by the in-memory
 * path (`lib/auth-lockout.ts`) and the Durable Object (`durable-objects/
 * rate-limit-room.ts`) so the two backends can never diverge.
 *
 * Layered ON TOP of the per-IP auth rate limiter: the IP limiter blunts a flood
 * from one source, but a *distributed* brute force that rotates IPs against a
 * single account slips under it. This tracks failures per identifier (across
 * IPs) and locks the account after `maxFails` within `windowMs`, with
 * exponential backoff on repeated lock cycles. A successful sign-in clears the
 * record (see `clearFailures`), so a legitimate user is never escalated.
 */

export interface LockState {
  /** Failures accumulated in the current window. */
  fails: number;
  /** Epoch ms of the first failure in the current window. */
  windowStart: number;
  /** Epoch ms the lock lifts; 0 = not locked. */
  lockedUntil: number;
  /** Consecutive lock cycles — drives the exponential backoff. Reset on a
   *  successful sign-in. */
  cycles: number;
}

export interface LockPolicy {
  /** Failures within `windowMs` that trip a lock. */
  maxFails: number;
  /** Failure-counting window. */
  windowMs: number;
  /** First lock duration; doubles each subsequent cycle. */
  baseCooldownMs: number;
  /** Ceiling for the backoff. */
  maxCooldownMs: number;
}

export interface LockResult {
  locked: boolean;
  /** ms until the lock lifts (>0 only when `locked`). */
  retryAfterMs: number;
  /** Attempts left before a lock (only meaningful when not locked; -1 when
   *  unknown / not applicable). */
  remaining: number;
  /** True only on the transition into a locked state — the caller audits this
   *  edge so the log isn't spammed on every subsequent blocked attempt. */
  justLocked: boolean;
}

const cooldownFor = (cycles: number, p: LockPolicy): number =>
  Math.min(p.maxCooldownMs, p.baseCooldownMs * 2 ** Math.max(0, cycles));

/** Read-only: is the account currently locked? Never mutates. */
export const evalLock = (s: LockState | undefined, now: number): LockResult => {
  if (s && s.lockedUntil > now) {
    return { locked: true, retryAfterMs: s.lockedUntil - now, remaining: 0, justLocked: false };
  }
  return { locked: false, retryAfterMs: 0, remaining: -1, justLocked: false };
};

/** Record one failure and return the next state + outcome. */
export const applyFailure = (
  prev: LockState | undefined,
  now: number,
  p: LockPolicy,
): { state: LockState; result: LockResult } => {
  let s: LockState = prev ?? { fails: 0, windowStart: now, lockedUntil: 0, cycles: 0 };

  // Already locked → don't extend it; just report the remaining time.
  if (s.lockedUntil > now) {
    return {
      state: s,
      result: { locked: true, retryAfterMs: s.lockedUntil - now, remaining: 0, justLocked: false },
    };
  }
  // Stale window → start a fresh count (cycles persist for backoff escalation).
  if (now - s.windowStart > p.windowMs) {
    s = { ...s, fails: 0, windowStart: now };
  }
  const fails = s.fails + 1;
  if (fails >= p.maxFails) {
    const cooldown = cooldownFor(s.cycles, p);
    const next: LockState = {
      fails: 0,
      windowStart: now,
      lockedUntil: now + cooldown,
      cycles: s.cycles + 1,
    };
    return {
      state: next,
      result: { locked: true, retryAfterMs: cooldown, remaining: 0, justLocked: true },
    };
  }
  const next: LockState = { fails, windowStart: s.windowStart, lockedUntil: 0, cycles: s.cycles };
  return {
    state: next,
    result: { locked: false, retryAfterMs: 0, remaining: p.maxFails - fails, justLocked: false },
  };
};

/** Epoch ms after which a state is safe to GC (lock lifted AND window stale). */
export const lockExpiry = (s: LockState, p: LockPolicy): number =>
  Math.max(s.lockedUntil, s.windowStart + p.windowMs);
