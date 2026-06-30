/**
 * @module
 *
 * Reactive (live) queries — subscribe to a query, not just a channel. You give
 * `liveQuery` a collection + filter/sort/limit and a callback; it runs the
 * initial `list()`, then keeps the result array consistent as rows change,
 * pushing the new array to your callback. No manual event wiring, no stale
 * data, no client reducer boilerplate.
 *
 * How it stays consistent: backlex already streams permission-filtered per-row
 * events over `items:<slug>` SSE. For a "simple" query (top-level field filter +
 * sort, no relations/search) the engine maintains the array INCREMENTALLY in JS
 * — insert/update/remove at the sorted position — so most changes need zero
 * extra round-trips. Anything it can't safely maintain in JS (expand, `q`
 * search, nested `a.b` filter/sort, `$now`/`$user` filter vars) transparently
 * falls back to a debounced refetch, which is always correct. With a `limit`,
 * the incremental apply is optimistic (instant) and a debounced refetch
 * reconciles the exact window.
 *
 * This lives entirely in the client: the server stays a stateless event
 * publisher, so live queries work across every backlex runtime (Bun, Workers,
 * Vercel, Netlify) with no per-subscription server state.
 */
import type { Condition, ComparisonObj } from "./condition";
import type { ItemEvent, ListQuery, ListResponse } from "./types";

/** Options for a live query — the same shape as `list()`. */
export type LiveQueryOptions = ListQuery;

/** Dependencies a live query needs from the client (injected so the engine
 *  stays decoupled + unit-testable). */
export interface LiveQueryDeps<T> {
  list: (q?: ListQuery) => Promise<ListResponse<T>>;
  subscribe: (
    channel: string,
    onEvent: (e: ItemEvent<T>) => void,
    onError?: (err: unknown) => void,
    /** Raw query string appended to the subscribe URL (e.g. `filter=…`). */
    query?: string,
  ) => () => void;
}

interface SortClause {
  field: string;
  dir: "asc" | "desc";
}

const parseSort = (sort: ListQuery["sort"]): SortClause[] => {
  if (!sort) return [];
  const list = Array.isArray(sort) ? sort : sort.split(",");
  return list
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({
      dir: s.startsWith("-") ? ("desc" as const) : ("asc" as const),
      field: s.replace(/^[-+]/, ""),
    }));
};

/** Compare two values for ORDER BY. Nullish sorts last (ASC). */
const cmpVal = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
};

const compareRows = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  clauses: SortClause[],
): number => {
  for (const { field, dir } of clauses) {
    const c = cmpVal(a[field], b[field]);
    if (c !== 0) return dir === "desc" ? -c : c;
  }
  return 0;
};

// ── Client-side condition matcher ──────────────────────────────────────────
// Mirrors the server's `matchesCondition` operator semantics for the cases the
// incremental path supports (literal values only — `$now`/`$user` filters route
// to refetch mode, so they never reach here).

const isAnd = (c: Condition): c is { $and: Condition[] } =>
  Array.isArray((c as { $and?: unknown }).$and);
const isOr = (c: Condition): c is { $or: Condition[] } =>
  Array.isArray((c as { $or?: unknown }).$or);
const isNot = (c: Condition): c is { $not: Condition } =>
  (c as { $not?: unknown }).$not !== undefined;

const matchLeaf = (left: unknown, cmp: ComparisonObj): boolean => {
  if (cmp._eq !== undefined && left !== cmp._eq) return false;
  if (cmp._neq !== undefined && left === cmp._neq) return false;
  if (cmp._in !== undefined && !cmp._in.includes(left)) return false;
  if (cmp._nin !== undefined && cmp._nin.includes(left)) return false;
  if (cmp._gt !== undefined && !(Number(left) > Number(cmp._gt))) return false;
  if (cmp._gte !== undefined && !(Number(left) >= Number(cmp._gte))) return false;
  if (cmp._lt !== undefined && !(Number(left) < Number(cmp._lt))) return false;
  if (cmp._lte !== undefined && !(Number(left) <= Number(cmp._lte))) return false;
  if (cmp._between !== undefined) {
    const n = Number(left);
    if (!(n >= Number(cmp._between[0]) && n <= Number(cmp._between[1]))) return false;
  }
  if (cmp._null === true && left != null) return false;
  if (cmp._null === false && left == null) return false;
  if (cmp._empty === true && !(left == null || left === "")) return false;
  if (cmp._nempty === true && (left == null || left === "")) return false;
  const s = (v: unknown) => String(left ?? "").includes(String(v));
  if (cmp._contains !== undefined && !s(cmp._contains)) return false;
  if (cmp._starts_with !== undefined && !String(left ?? "").startsWith(String(cmp._starts_with))) return false;
  if (cmp._ends_with !== undefined && !String(left ?? "").endsWith(String(cmp._ends_with))) return false;
  const lc = String(left ?? "").toLowerCase();
  if (cmp._icontains !== undefined && !lc.includes(String(cmp._icontains).toLowerCase())) return false;
  if (cmp._istarts_with !== undefined && !lc.startsWith(String(cmp._istarts_with).toLowerCase())) return false;
  if (cmp._iends_with !== undefined && !lc.endsWith(String(cmp._iends_with).toLowerCase())) return false;
  return true;
};

/** Evaluate a (normalized) condition against a plain row in JS. */
export const matchesRow = (row: Record<string, unknown>, cond: Condition): boolean => {
  if (isAnd(cond)) return cond.$and.every((c) => matchesRow(row, c));
  if (isOr(cond)) return cond.$or.some((c) => matchesRow(row, c));
  if (isNot(cond)) return !matchesRow(row, cond.$not);
  for (const [field, cmp] of Object.entries(cond as Record<string, ComparisonObj>)) {
    if (!matchLeaf(row[field], cmp)) return false;
  }
  return true;
};

// ── Incremental-safety classifier ──────────────────────────────────────────

const isRelativeOrVar = (v: unknown): boolean =>
  (typeof v === "string" && v.startsWith("$")) ||
  (typeof v === "object" && v !== null && "$now" in (v as object));

/** A condition is incremental-safe when every key is a plain top-level field
 *  (no `a.b` relation path) and no comparison value is a `$now`/`$user` token
 *  (those resolve server-side; matching them in JS would drift). */
const conditionSafe = (cond: Condition): boolean => {
  if (isAnd(cond)) return cond.$and.every(conditionSafe);
  if (isOr(cond)) return cond.$or.every(conditionSafe);
  if (isNot(cond)) return conditionSafe(cond.$not);
  for (const [field, cmp] of Object.entries(cond as Record<string, ComparisonObj>)) {
    if (field.includes(".")) return false;
    for (const v of Object.values(cmp)) {
      if (Array.isArray(v)) {
        if (v.some(isRelativeOrVar)) return false;
      } else if (isRelativeOrVar(v)) return false;
    }
  }
  return true;
};

/** Whether a condition is free of nested (`a.b`) relation keys. Such a filter
 *  can be sent to the server for narrowing even if it carries `$now`/`$user`
 *  (the server resolves those) — unlike {@link conditionSafe}, which is about
 *  what the CLIENT can evaluate in JS. */
const noNestedKeys = (cond: Condition): boolean => {
  if (isAnd(cond)) return cond.$and.every(noNestedKeys);
  if (isOr(cond)) return cond.$or.every(noNestedKeys);
  if (isNot(cond)) return noNestedKeys(cond.$not);
  return Object.keys(cond as Record<string, unknown>).every((k) => !k.includes("."));
};

/** Whether the engine can maintain this query incrementally. Anything that
 *  needs server-computed shape (expand, `q` search, nested sort/filter,
 *  relative/var filter values) routes to refetch mode instead. */
export const isIncrementalSafe = (opts: LiveQueryOptions): boolean => {
  if (opts.expand) return false;
  if (opts.q) return false;
  if (opts.filter && !conditionSafe(opts.filter)) return false;
  for (const s of parseSort(opts.sort)) if (s.field.includes(".")) return false;
  return true;
};

// ── The engine ─────────────────────────────────────────────────────────────

/** Start a live query. Calls `onResult` with the initial result, then again
 *  with a fresh array on every change. Returns an unsubscribe function. */
export const createLiveQuery = <T extends Record<string, unknown>>(
  deps: LiveQueryDeps<T>,
  slug: string,
  opts: LiveQueryOptions,
  onResult: (rows: T[]) => void,
  onError?: (err: unknown) => void,
): (() => void) => {
  let rows: T[] = [];
  let closed = false;
  const limit = opts.limit;
  const sortClauses = parseSort(opts.sort);
  const cond = opts.filter ?? null;
  const sortHasNested = sortClauses.some((s) => s.field.includes("."));
  // When the filter has no nested keys we can hand it to the server, which
  // narrows the stream AND emits membership transitions (reactive Stage 2). We
  // then TRUST those transitions instead of re-evaluating the filter in JS —
  // which is what lets `$now`/`$user` filters maintain incrementally (the
  // client can't resolve those, but the server can).
  const serverFilter =
    cond && noNestedKeys(cond) && !opts.expand && !opts.q && !sortHasNested
      ? cond
      : null;
  // `incremental` stays conservative (isIncrementalSafe): we only force the
  // in-JS path for filters the client could maintain anyway. Sending
  // serverFilter is an orthogonal bandwidth optimisation — it narrows the
  // stream in BOTH incremental and refetch modes. Trusting the server's
  // `$user`/`$now` transitions to make those incremental would require knowing
  // the server implements Stage 2; that capability negotiation is deferred.
  const incremental = isIncrementalSafe(opts);
  // Top-level field projection (matches the simple-query constraints — `fields`
  // with relation dot-paths would have forced refetch mode via `expand`).
  const projectFields =
    typeof opts.fields === "string"
      ? opts.fields.split(",").map((f) => f.trim()).filter(Boolean)
      : Array.isArray(opts.fields)
        ? opts.fields
        : null;

  const emit = () => {
    if (!closed) onResult(rows.slice());
  };

  const project = (row: T): T => {
    if (!projectFields || projectFields.some((f) => f.includes("."))) return row;
    const out: Record<string, unknown> = {};
    if ("id" in row) out.id = (row as Record<string, unknown>).id;
    for (const f of projectFields) if (f in row) out[f] = (row as Record<string, unknown>)[f];
    return out as T;
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let refetching = false;
  let again = false;
  const doRefetch = async () => {
    if (refetching) {
      again = true;
      return;
    }
    refetching = true;
    try {
      const res = await deps.list(opts);
      if (!closed) {
        rows = res.data;
        emit();
      }
    } catch (e) {
      onError?.(e);
    } finally {
      refetching = false;
      if (again && !closed) {
        again = false;
        scheduleRefetch();
      }
    }
  };
  const scheduleRefetch = (delay = 80) => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void doRefetch();
    }, delay);
  };

  const applyEvent = (ev: ItemEvent<T>) => {
    if (!incremental) {
      scheduleRefetch();
      return;
    }
    const row = ev.data as Record<string, unknown>;
    const id = row?.id as string | undefined;
    if (row == null || id == null) {
      scheduleRefetch();
      return;
    }
    const idx = rows.findIndex((r) => (r as Record<string, unknown>).id === id);

    const removeAt = (i: number) => {
      const wasFull = limit != null && rows.length >= limit;
      rows.splice(i, 1);
      // A removal from a FULL window opens a slot an off-window row (we don't
      // have cached) should slide into — reconcile. A removal from a non-full
      // window leaves no gap to fill, so no refetch (Stage 3).
      if (wasFull) scheduleRefetch();
    };

    if (ev.event === "deleted") {
      if (idx >= 0) {
        removeAt(idx);
        emit();
      }
      return;
    }

    // created / updated — decide membership. Trust the server's transition
    // when it sent one (it already evaluated the filter, incl. $user/$now):
    // anything but `leave` is a member. With no transition (older / Stage-1
    // server, or an unfiltered subscription) fall back to the local filter.
    const member =
      ev.transition !== undefined
        ? ev.transition !== "leave"
        : cond
          ? matchesRow(row, cond)
          : true;
    if (!member) {
      if (idx >= 0) {
        removeAt(idx);
        emit();
      }
      return;
    }
    const projected = project(ev.data);
    const sort = () => {
      if (sortClauses.length) {
        rows.sort((a, b) =>
          compareRows(a as Record<string, unknown>, b as Record<string, unknown>, sortClauses),
        );
      }
    };

    // ── Update of a row already in the window ──────────────────────────────
    if (idx >= 0) {
      const old = rows[idx] as Record<string, unknown>;
      const moved = sortClauses.length > 0 && compareRows(old, row, sortClauses) !== 0;
      rows[idx] = projected;
      if (moved) sort();
      // A move within a FULL window can push this row toward the edge, where an
      // off-window row (uncached) might now outrank it — reconcile. A move in a
      // non-full window, or an update that didn't change the sort key, needs no
      // refetch (Stage 3).
      if (moved && limit != null && rows.length >= limit) scheduleRefetch();
      emit();
      return;
    }

    // ── New row entering the window ────────────────────────────────────────
    const full = limit != null && rows.length >= limit;
    if (full && sortClauses.length) {
      // Compare to the boundary (last visible row). Strictly after it → the new
      // row is off-window: drop it with NO refetch (Stage 3). Otherwise it's
      // in-window: insert, sort, and evict the overflow row — which is now
      // off-window and correctly hidden, so still NO refetch.
      const boundary = rows[rows.length - 1] as Record<string, unknown>;
      if (compareRows(row, boundary, sortClauses) > 0) return;
      rows.push(projected);
      sort();
      rows = rows.slice(0, limit!);
      emit();
      return;
    }

    // Non-full window (or no sort to reason about the boundary): plain insert.
    rows.push(projected);
    sort();
    if (limit != null && rows.length > limit) {
      // Only reachable without a sort order (can't tell which row is off-window)
      // — keep the conservative slice + reconcile.
      rows = rows.slice(0, limit);
      scheduleRefetch();
    }
    emit();
  };

  // Initial load.
  void (async () => {
    try {
      const res = await deps.list(opts);
      if (!closed) {
        rows = res.data;
        emit();
      }
    } catch (e) {
      onError?.(e);
    }
  })();

  const filterQuery = serverFilter
    ? `filter=${encodeURIComponent(JSON.stringify(serverFilter))}`
    : undefined;
  const unsub = deps.subscribe(`items:${slug}`, applyEvent, onError, filterQuery);
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    unsub();
  };
};
