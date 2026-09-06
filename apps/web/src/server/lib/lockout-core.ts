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

/**
 * How long an account must be QUIET before the exponential backoff relaxes.
 *
 * `cycles` only ever went up. It was reset by `clearFailures`, and
 * `clearFailures` is only reached on a successful sign-in — which the person
 * being locked out cannot produce while they are locked out. So four cycles
 * pinned the cooldown at its 15-minute ceiling and it STAYED there: an attacker
 * who knew an address could hold the account shut indefinitely at eight
 * requests every fifteen minutes (~0.009 req/s), under every other limit in the
 * system, with no way for the owner to recover but an operator.
 *
 * Decay does not stop a sustained attack on its own — that is what the
 * per-source lock in `auth-rate-limit.ts` is for. What it fixes is that the
 * penalty outlived the attack: an hour of quiet now walks the backoff back to
 * where it started.
 */
const CYCLE_DECAY_MS = 60 * 60_000;

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
  // How long this account has been quiet, measured BEFORE the window is reset.
  //
  // Order matters and cost this fix a round: the stale-window branch below sets
  // `windowStart = now`, so reading it afterwards always answers "no time has
  // passed" and the decay could never fire. `lockedUntil` is when the last lock
  // ENDED; `windowStart` covers an account that has never locked.
  const quietFor = now - Math.max(s.lockedUntil, s.windowStart);
  // Stale window → start a fresh count (cycles persist for backoff escalation).
  if (now - s.windowStart > p.windowMs) {
    s = { ...s, fails: 0, windowStart: now };
  }
  // …but the escalation itself decays.
  if (s.cycles > 0 && quietFor > CYCLE_DECAY_MS) {
    s = { ...s, cycles: 0 };
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
