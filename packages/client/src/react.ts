/**
 * @module
 *
 * React bindings. Import from `backlex/react` (React is an optional peer).
 *
 * The SDK already owns the hard parts — `liveQuery` keeps a consistent result
 * array across realtime events, and `core.setToken` is the one place a session
 * is written. What was missing was the twenty lines of `useState` each of those
 * needed to become a component, which every application wrote for itself and
 * every example in this repository wrote identically.
 *
 *   const { data, loading } = useLiveQuery(client, "todos", { sort: "-created_at" });
 *   const { status, user } = useSession(client);
 *
 * There is no query cache here and no TanStack Query peer, by design: `live.ts`
 * already maintains an incrementally-consistent array, so a second cache would
 * be a second source of truth for the same rows.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BacklexClient } from "./index";
import type { LiveQueryOptions } from "./live";
import type { AuthSessionState } from "./clients/auth";
import type {
  AggregateQuery,
  AggregateRow,
  ItemResponse,
  ListQuery,
  ResumableUploadResult,
} from "./types";

/** Options that shape the HOOK rather than the query it runs. */
export interface UseQueryHookOptions {
  /**
   * Keep the previous result on screen while a changed query loads, instead of
   * clearing to an empty list.
   *
   * **Off by default, deliberately.** The default renders one query's rows
   * only as that query's result; turning this on means the rows on screen
   * briefly belong to the PREVIOUS query, which is right for a paginated table
   * and wrong for a detail panel. `refreshing` tells you which state you are
   * looking at.
   */
  keepPreviousData?: boolean;
  /** Skip the query entirely — for a read that depends on something not ready
   *  yet, without breaking the rules of hooks to do it. */
  enabled?: boolean;
}

export interface UseLiveQueryResult<T> {
  /** The current result array — replaced (new reference) on every change. */
  data: T[];
  /** True until the first result (or error) arrives. */
  loading: boolean;
  /** The last error from the initial load or a reconcile refetch, else null. */
  error: unknown;
  /** Loading while rows are still on screen — i.e. `keepPreviousData` is on
   *  and this is a refresh rather than a first load. Lets a UI dim a table
   *  instead of replacing it with a skeleton. */
  refreshing: boolean;
  /** Re-run the query from scratch. Tears the subscription down and rebuilds
   *  it, which is the only handle `liveQuery` offers — cheap, but not free, so
   *  this is for a user pressing refresh rather than for polling. */
  refetch: () => void;
}

/**
 * Subscribe to a live query for the lifetime of the component. Re-subscribes
 * when `slug` or the (deep-equal) `opts` change; unsubscribes on unmount.
 */
export function useLiveQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  client: BacklexClient,
  slug: string,
  opts: LiveQueryOptions,
  hookOpts?: UseQueryHookOptions,
): UseLiveQueryResult<T> {
  const keepPreviousData = hookOpts?.keepPreviousData ?? false;
  const enabled = hookOpts?.enabled ?? true;

  const [state, setState] = useState<{ data: T[]; loading: boolean; error: unknown }>({
    data: [],
    loading: true,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  // Deep-equal key: a re-render that passes an equal-but-new `opts` object
  // shouldn't tear down and rebuild the subscription.
  const key = JSON.stringify([slug, opts]);

  useEffect(() => {
    if (!enabled) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    // Clear the previous subscription's rows unless the caller opted out:
    // between teardown and the new query's first result, stale data would
    // render as the WRONG query's result.
    setState((prev) => ({
      data: keepPreviousData ? prev.data : [],
      loading: true,
      error: null,
    }));
    const unsub = client.liveQuery<T>(
      slug,
      opts,
      (rows) => setState({ data: rows, loading: false, error: null }),
      (e) =>
        setState((prev) => ({
          data: keepPreviousData ? prev.data : [],
          loading: false,
          error: e,
        })),
    );
    return unsub;
    // `key` captures slug+opts; `nonce` is what `refetch` bumps.
  }, [client, key, nonce, keepPreviousData, enabled]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    refreshing: state.loading && state.data.length > 0,
    refetch,
  };
}

// ── One-shot reads ──────────────────────────────────────────────────────────

/**
 * Runs a callback whose result replaces state, discarding any answer that
 * arrives out of order.
 *
 * The race is real and silent: change a filter twice quickly and the FIRST
 * request can resolve last, leaving the screen showing a result for a query
 * nobody is asking any more. A generation counter is what makes the late
 * answer identifiable as stale.
 */
const useAsyncResult = <R>(
  run: () => Promise<R>,
  key: string,
  enabled: boolean,
  initial: R,
): { data: R; loading: boolean; error: unknown; refetch: () => void } => {
  const [state, setState] = useState<{ data: R; loading: boolean; error: unknown }>({
    data: initial,
    loading: enabled,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) {
      setState({ data: initial, loading: false, error: null });
      return;
    }
    const mine = ++generation.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    runRef
      .current()
      .then((data) => {
        if (mine === generation.current) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (mine === generation.current) setState({ data: initial, loading: false, error });
      });
    return () => {
      // A component unmounting mid-flight must not land its result either.
      generation.current++;
    };
    // `initial` is a caller-side constant; including it would re-run on every
    // render for anyone passing a literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, enabled]);

  return { ...state, refetch: useCallback(() => setNonce((n) => n + 1), []) };
};

export interface UseListResult<T> {
  data: T[];
  /** Total matching rows when the server reported one, else `null`. */
  total: number | null;
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * A plain paged read — no subscription, no realtime.
 *
 * Reach for this over `useLiveQuery` when the rows do not change under the
 * user (a report, a picker, a page of history): it costs one request instead
 * of a request plus an open stream.
 */
export function useList<T extends Record<string, unknown> = Record<string, unknown>>(
  client: BacklexClient,
  slug: string,
  query?: ListQuery,
  hookOpts?: UseQueryHookOptions,
): UseListResult<T> {
  const enabled = hookOpts?.enabled ?? true;
  const key = JSON.stringify([slug, query ?? null]);
  const empty = useMemo<{ data: T[]; total: number | null }>(() => ({ data: [], total: null }), []);

  const res = useAsyncResult(
    async () => {
      const r = await client.from<T>(slug).list(query);
      const total = (r as { total?: number }).total;
      return { data: r.data ?? [], total: typeof total === "number" ? total : null };
    },
    key,
    enabled,
    empty,
  );

  return {
    data: res.data.data,
    total: res.data.total,
    loading: res.loading,
    error: res.error,
    refetch: res.refetch,
  };
}

export interface UseAggregateResult {
  data: AggregateRow[];
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

/** One aggregate (count/sum/avg/min/max), optionally grouped. */
export function useAggregate(
  client: BacklexClient,
  slug: string,
  body: AggregateQuery,
  hookOpts?: UseQueryHookOptions,
): UseAggregateResult {
  const enabled = hookOpts?.enabled ?? true;
  const empty = useMemo<AggregateRow[]>(() => [], []);
  const res = useAsyncResult(
    async () => (await client.from(slug).aggregate(body)).data ?? [],
    JSON.stringify([slug, body]),
    enabled,
    empty,
  );
  return res;
}

// ── Session ─────────────────────────────────────────────────────────────────

export interface UseSessionResult extends AuthSessionState {
  /** True while the session has not been settled yet — `status === "unknown"`.
   *  This is the flag every example SPA was hand-rolling as `booting`. */
  loading: boolean;
  /** A failed session probe. The status is deliberately NOT set to anonymous
   *  by a failure: a dropped connection is not a sign-out. */
  error: unknown;
  /** Re-ask the server who this is. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

/**
 * The signed-in user, kept in step with sign-in and sign-out anywhere in the
 * app.
 *
 * Reads through `useSyncExternalStore`, so the state comes from the client
 * rather than from a copy React owns — two components using this hook cannot
 * disagree, and neither can a component and a plain `client.auth` call.
 */
export function useSession(client: BacklexClient): UseSessionResult {
  const state = useSyncExternalStore(
    // Both are stable methods on the auth client, which is what keeps
    // `useSyncExternalStore` from resubscribing on every render. `getState`
    // returns a cached reference for the same reason.
    client.auth.onChange,
    client.auth.getState,
    client.auth.getState,
  );
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (state.status !== "unknown") return;
    let live = true;
    client.auth
      .resolve()
      .then(() => {
        if (live) setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [client, state.status]);

  const refresh = useCallback(async () => {
    try {
      await client.auth.resolve();
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [client]);

  const signOut = useCallback(async () => {
    await client.auth.signOut();
  }, [client]);

  return { ...state, loading: state.status === "unknown", error, refresh, signOut };
}

// ── Optimistic writes ───────────────────────────────────────────────────────

type OptimisticOp<T> =
  | { kind: "create"; id: string; row: T }
  | { kind: "update"; id: string; patch: Partial<T> }
  | { kind: "delete"; id: string };

export interface UseOptimisticResult<T> {
  /** Apply the pending operations to a server-supplied array. Pure — call it
   *  during render. */
  overlay(rows: T[]): T[];
  /** Register an operation; returns the function that takes it back. */
  add(op: OptimisticOp<T>): () => void;
  /** How many operations are still in flight. */
  pending: number;
}

/**
 * Holds the writes that have been made but not yet confirmed, so a list can
 * show them immediately.
 *
 * Kept separate from the query hook on purpose: the overlay is applied by the
 * component, which means a caller can decide that some views show pending rows
 * and others do not, and neither hook has to know about the other.
 */
export function useOptimistic<
  T extends Record<string, unknown> = Record<string, unknown>,
>(): UseOptimisticResult<T> {
  const ops = useRef<OptimisticOp<T>[]>([]);
  /** Ops the source array has caught up with, collected during render and
   *  dropped after it. */
  const inert = useRef<Set<OptimisticOp<T>>>(new Set());
  const [version, bump] = useState(0);

  const add = useCallback((op: OptimisticOp<T>) => {
    ops.current = [...ops.current, op];
    bump((n) => n + 1);
    return () => {
      if (!ops.current.includes(op)) return;
      ops.current = ops.current.filter((o) => o !== op);
      bump((n) => n + 1);
    };
  }, []);

  const overlay = useCallback(
    (rows: T[]): T[] => {
      if (ops.current.length === 0) return rows;
      const done = new Set<OptimisticOp<T>>();
      let out = rows;
      for (const op of ops.current) {
        if (op.kind === "create") {
          // Retired once the row has actually arrived, so it is never drawn
          // twice — and kept until then, which is what stops a confirmed
          // create from blinking out while the list catches up.
          if (out.some((r) => r.id === op.id)) {
            done.add(op);
            continue;
          }
          out = [op.row, ...out];
        } else if (op.kind === "update") {
          const current = out.find((r) => r.id === op.id);
          // Retired once the stored row already says what the patch said. The
          // alternative — dropping on a successful response — renders the OLD
          // value again until the change arrives, which is the flicker this
          // whole hook exists to remove.
          if (current && Object.entries(op.patch).every(([k, v]) => current[k] === v)) {
            done.add(op);
            continue;
          }
          out = out.map((r) => (r.id === op.id ? { ...r, ...op.patch } : r));
        } else {
          if (!out.some((r) => r.id === op.id)) {
            done.add(op);
            continue;
          }
          out = out.filter((r) => r.id !== op.id);
        }
      }
      inert.current = done;
      return out;
    },
    // `version` is what makes a newly added op reach the next render; the ops
    // themselves live in a ref so a retirement costs no extra render.
    [version],
  );

  useEffect(() => {
    if (inert.current.size === 0) return;
    const drop = inert.current;
    inert.current = new Set();
    // No `bump` here on purpose: an op the array already reflects contributes
    // nothing to `overlay`'s output, so dropping it cannot change what is on
    // screen — and re-rendering for it would loop.
    ops.current = ops.current.filter((o) => !drop.has(o));
  });

  return { overlay, add, pending: ops.current.length };
}

export interface UseItemMutationResult<T> {
  create(data: Partial<T>): Promise<ItemResponse<T>>;
  update(id: string, patch: Partial<T>): Promise<ItemResponse<T>>;
  remove(id: string): Promise<{ ok: boolean }>;
  /** Apply in-flight writes to a list, so the screen changes on click. */
  overlay(rows: T[]): T[];
  /** True while any write is in flight. */
  pending: boolean;
  /** The last write that failed. Its optimistic change has already been rolled
   *  back by the time this is set. */
  error: unknown;
}

/** A temporary id for a row the server has not named yet. Prefixed so it is
 *  obvious in a log that it never came from the database. */
const tempId = (): string =>
  `optimistic-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Create / update / delete with the change on screen immediately and rolled
 * back if the write fails.
 *
 * Pair it with `useLiveQuery`: the realtime event confirms the write a moment
 * later and the overlay drops out, so the row never renders twice.
 *
 *   const rows = useLiveQuery(client, "todos", {});
 *   const m = useItemMutation(client, "todos");
 *   return <List rows={m.overlay(rows.data)} onAdd={(t) => m.create({ title: t })} />;
 */
export function useItemMutation<T extends Record<string, unknown> = Record<string, unknown>>(
  client: BacklexClient,
  slug: string,
): UseItemMutationResult<T> {
  const optimistic = useOptimistic<T>();
  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const { add } = optimistic;

  const run = useCallback(
    async <R>(revert: () => void, work: () => Promise<R>): Promise<R> => {
      setInFlight((n) => n + 1);
      try {
        const result = await work();
        setError(null);
        // Deliberately NOT reverted here. A confirmed change stays on screen
        // until the list it is drawn from says the same thing, and retires
        // itself then — dropping it on the response is what makes an
        // optimistic update flash back to its old value.
        return result;
      } catch (e) {
        // Rolled back BEFORE the error is surfaced, so a component that
        // renders on `error` never paints the failed change next to the
        // message saying it failed.
        revert();
        setError(e);
        throw e;
      } finally {
        setInFlight((n) => n - 1);
      }
    },
    [],
  );

  const create = useCallback(
    (data: Partial<T>) => {
      const id = tempId();
      const revert = add({ kind: "create", id, row: { ...data, id } as unknown as T });
      return run(revert, async () => {
        const res = await client.from<T>(slug).create(data);
        const row = res.data as T | undefined;
        // Hand the placeholder over to the real row. Without this the overlay
        // would hold a temporary id the list can never match, and the new row
        // would be drawn twice — once as the guess and once as the truth.
        if (row && typeof row.id === "string") {
          revert();
          add({ kind: "create", id: row.id, row });
        }
        return res;
      });
    },
    [add, client, run, slug],
  );

  const update = useCallback(
    (id: string, patch: Partial<T>) => {
      const revert = add({ kind: "update", id, patch });
      return run(revert, () => client.from<T>(slug).update(id, patch));
    },
    [add, client, run, slug],
  );

  const remove = useCallback(
    (id: string) => {
      const revert = add({ kind: "delete", id });
      return run(revert, () => client.from<T>(slug).delete(id));
    },
    [add, client, run, slug],
  );

  return {
    create,
    update,
    remove,
    overlay: optimistic.overlay,
    pending: inFlight > 0,
    error,
  };
}

// ── Uploads ─────────────────────────────────────────────────────────────────

export interface UseUploadResult {
  upload(input: {
    key: string;
    data: Blob | ArrayBuffer | Uint8Array;
    contentType?: string;
    folderId?: string;
    chunkSize?: number;
  }): Promise<ResumableUploadResult>;
  /** 0 to 1. Meaningful only while `uploading`. */
  progress: number;
  uploading: boolean;
  error: unknown;
  /** Abort the upload in flight. A resumable upload can be picked up again
   *  from the server's offset with `client.storage.resumeUpload`. */
  cancel(): void;
}

/** A resumable upload with progress, wired to a component's lifetime. */
export function useUpload(client: BacklexClient): UseUploadResult {
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const abort = useRef<AbortController | null>(null);

  // An upload outliving its component would keep calling `setProgress` on an
  // unmounted tree, and would go on consuming the user's bandwidth for a screen
  // they have left.
  useEffect(() => () => abort.current?.abort(), []);

  const upload = useCallback<UseUploadResult["upload"]>(
    async (input) => {
      const controller = new AbortController();
      abort.current = controller;
      setUploading(true);
      setProgress(0);
      setError(null);
      try {
        return await client.storage.uploadResumable({
          ...input,
          signal: controller.signal,
          onProgress: (sent, total) => setProgress(total > 0 ? sent / total : 0),
        });
      } catch (e) {
        setError(e);
        throw e;
      } finally {
        setUploading(false);
        abort.current = null;
      }
    },
    [client],
  );

  const cancel = useCallback(() => abort.current?.abort(), []);

  return { upload, progress, uploading, error, cancel };
}
