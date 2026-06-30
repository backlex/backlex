/**
 * Shared, dependency-light realtime predicate + per-subscriber rendering — the
 * single source of truth for "should this subscriber see this row event, and in
 * what shape?", used by BOTH transports (the in-process / Redis fan-out in
 * events.ts AND the Durable Object's per-socket deliver()). Keeping it here,
 * importing only `matchesCondition`, means the two paths can't drift — which
 * matters most for the membership-transition logic (reactive invalidation
 * Stage 2), where a mismatch would silently leak or drop rows on one runtime
 * but not the other.
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
  /** Read field allow-list (`null` = all readable). Applied to the emitted row. */
  fields?: string[] | null;
}

const SYSTEM_FIELDS = new Set(["id", "createdAt", "updatedAt", "ownerId"]);

/** Project a row down to the caller's readable fields (system fields always
 *  survive). `null` fields = no projection. */
export const projectRow = (
  data: Record<string, unknown>,
  fields: string[] | null | undefined,
): Record<string, unknown> => {
  if (!fields) return data;
  const allow = new Set(fields);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SYSTEM_FIELDS.has(k) || allow.has(k)) out[k] = v;
  }
  return out;
};

/** Permission gate only (ignores the live-query filter). */
const permissionPasses = (
  row: Record<string, unknown>,
  f: RealtimeFilter,
): boolean => {
  if (f.conditions === null) return true;
  if (f.conditions.length === 0) return false;
  return f.conditions.some((c) => matchesCondition(row, c, f.authSubject));
};

/**
 * Whether `row` satisfies the permission conditions AND the (optional) live-
 * query filter, evaluated with this subscriber's own identity (`$user.*` /
 * `$tenant.id` / `$now` resolve against `authSubject`).
 */
export const rowPasses = (
  row: Record<string, unknown>,
  f: RealtimeFilter,
): boolean =>
  permissionPasses(row, f) &&
  (f.queryFilter == null || matchesCondition(row, f.queryFilter, f.authSubject));

/**
 * Membership transition for an `updated` event (reactive invalidation Stage 2).
 * Given the row BEFORE and AFTER the write, decide what happened to its
 * membership in this subscriber's result set (combined permission ∧ filter):
 *
 *  - `enter`  — wasn't a member before, is now (send the row)
 *  - `leave`  — was, isn't now (client must drop it)
 *  - `update` — member before and after (send the row)
 *  - `none`   — member neither before nor after (drop)
 *
 * `before` may be absent (older publishers) — then enter-vs-update can't be
 * told apart, so fall back to "update if it matches now".
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

/** An event as published (carries the server-only `before` on updates). */
export interface IncomingItemEvent {
  event: "created" | "updated" | "deleted";
  data: Record<string, unknown>;
  /** Pre-write row — server-only, used to compute transitions, never emitted. */
  before?: Record<string, unknown>;
}

/** What actually goes on the wire to a subscriber. `before` is never present;
 *  `transition` is set only when the subscription carries a live-query filter. */
export interface OutgoingItemEvent {
  event: "created" | "updated" | "deleted";
  transition?: Transition;
  data: Record<string, unknown>;
}

/** Strip the server-only `before` from an item payload before it ever reaches
 *  a client (defensive — used on the meta-less raw-forward path). */
export const stripBefore = (payload: unknown): unknown => {
  if (
    payload &&
    typeof payload === "object" &&
    "before" in (payload as Record<string, unknown>)
  ) {
    const { before: _before, ...rest } = payload as Record<string, unknown>;
    return rest;
  }
  return payload;
};

/**
 * Render an item event for one subscriber, or `null` to drop it. This is the
 * one place per-subscriber visibility + projection + (Stage 2) membership
 * transitions are decided, shared by every transport.
 *
 * Without a live-query filter it's the legacy behavior: permission gate +
 * projection, plain `{event, data}` (byte-for-byte unchanged for non-reactive
 * subscribers). With a filter it annotates the `transition` and, crucially,
 * still emits a `leave` when an update pushes a row OUT of the result set (the
 * after-row fails the filter) so the client knows to drop it.
 */
export const renderItemEvent = (
  ev: IncomingItemEvent,
  f: RealtimeFilter,
): OutgoingItemEvent | null => {
  const project = (row: Record<string, unknown>) => projectRow(row, f.fields ?? null);

  if (f.queryFilter == null) {
    if (!rowPasses(ev.data, f)) return null;
    return { event: ev.event, data: project(ev.data) };
  }

  if (ev.event === "deleted") {
    // No before-row for deletes, so we can't tell if it was in-window. Emit a
    // removal for any row the caller could READ (removing an id the client
    // doesn't hold is a harmless no-op); gate on permission so we never signal
    // the existence of a row the caller could never see.
    if (!permissionPasses(ev.data, f)) return null;
    return { event: "deleted", transition: "leave", data: project(ev.data) };
  }

  if (ev.event === "created") {
    // A brand-new row is an `enter` when it matches (no before to compare).
    if (!rowPasses(ev.data, f)) return null;
    return { event: "created", transition: "enter", data: project(ev.data) };
  }

  const t = computeTransition(ev.before, ev.data, f);
  if (t === "none") return null;
  if (t === "leave") {
    // The after-row no longer matches the filter; still emit so the client
    // drops it. The projected after-row carries the id.
    return { event: "updated", transition: "leave", data: project(ev.data) };
  }
  // enter | update — the after-row is a member; send it.
  return { event: ev.event, transition: t, data: project(ev.data) };
};
