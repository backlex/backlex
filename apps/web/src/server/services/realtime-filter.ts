/**
 * Shared, dependency-light realtime predicate — the single source of truth for
 * "should this subscriber see this row event?", used by BOTH transports (the
 * in-process / Redis fan-out in events.ts AND the Durable Object's per-socket
 * deliver()). Keeping it here, importing only `matchesCondition`, means the two
 * paths can't drift — which matters most for the membership-transition logic
 * (reactive invalidation Stage 2), where a mismatch would silently leak or drop
 * rows on one runtime but not the other.
 *
 * See docs/reactive-invalidation-plan.md.
 */
import { matchesCondition } from "@backlex/db";
import type { AuthSubject, Condition } from "@backlex/core";

/** The structural subset of a subscription both transports already carry. */
export interface RealtimeFilter {
  authSubject: AuthSubject;
  /** Permission conditions. `null` = unrestricted (admin / unconditional). An
   *  empty array = deny-all (a non-admin whose role grants no matching row). */
  conditions: Condition[] | null;
  /** Optional live-query filter, AND'd on top of the permission conditions. It
   *  only ever *narrows* — never widens past what permission allows. */
  queryFilter?: Condition | null;
}

/**
 * Whether `row` satisfies the permission conditions AND the (optional) live-
 * query filter, evaluated with this subscriber's own identity (`$user.*` /
 * `$tenant.id` / `$now` resolve against `authSubject`).
 */
export const rowPasses = (
  row: Record<string, unknown>,
  f: RealtimeFilter,
): boolean => {
  if (f.conditions !== null) {
    if (f.conditions.length === 0) return false;
    if (!f.conditions.some((c) => matchesCondition(row, c, f.authSubject))) {
      return false;
    }
  }
  if (
    f.queryFilter != null &&
    !matchesCondition(row, f.queryFilter, f.authSubject)
  ) {
    return false;
  }
  return true;
};

/**
 * Membership transition for an `updated` event (reactive invalidation Stage 2).
 * Given the row BEFORE and AFTER the write, decide what happened to its
 * membership in this subscriber's result set:
 *
 *  - `enter`  — wasn't visible/matching before, is now (send the row)
 *  - `leave`  — was, isn't now (send just the id so the client drops it)
 *  - `update` — matched before and after (send the row)
 *  - `none`   — irrelevant both before and after (drop)
 *
 * `before` may be absent (older publishers / created events) — then we can't
 * tell enter-vs-update apart and fall back to "update if it matches now", which
 * is what the client already handles.
 */
export type Transition = "enter" | "leave" | "update" | "none";

export const computeTransition = (
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown>,
  f: RealtimeFilter,
): Transition => {
  const afterIn = rowPasses(after, f);
  if (before == null) return afterIn ? "update" : "none";
  const beforeIn = rowPasses(before, f);
  if (beforeIn && afterIn) return "update";
  if (!beforeIn && afterIn) return "enter";
  if (beforeIn && !afterIn) return "leave";
  return "none";
};
