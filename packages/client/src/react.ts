/**
 * @module
 *
 * React binding for reactive queries. `useLiveQuery` subscribes to a collection
 * query and re-renders with a fresh, consistent result array whenever the data
 * changes — the manual `useEffect` + subscribe + reducer + cleanup boilerplate,
 * gone. Import from `backlex/react` (React is an optional peer dependency).
 *
 *   const { data, loading, error } = useLiveQuery(client, "todos", {
 *     filter: { done: { _eq: false } },
 *     sort: "-created_at",
 *     limit: 50,
 *   });
 */
import { useEffect, useState } from "react";
import type { BacklexClient } from "./index";
import type { LiveQueryOptions } from "./live";

export interface UseLiveQueryResult<T> {
  /** The current result array — replaced (new reference) on every change.
   *  Reset to `[]` while a new subscription (changed `slug`/`opts`) loads, so
   *  one query's rows are never shown as another query's result. */
  data: T[];
  /** True until the first result (or error) arrives. */
  loading: boolean;
  /** The last error from the initial load or a reconcile refetch, else null. */
  error: unknown;
}

/**
 * Subscribe to a live query for the lifetime of the component. Re-subscribes
 * when `slug` or the (deep-equal) `opts` change; unsubscribes on unmount.
 */
export function useLiveQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  client: BacklexClient,
  slug: string,
  opts: LiveQueryOptions,
): UseLiveQueryResult<T> {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Deep-equal key: a re-render that passes an equal-but-new `opts` object
  // shouldn't tear down and rebuild the subscription.
  const key = JSON.stringify([slug, opts]);

  useEffect(() => {
    // Clear the previous subscription's rows: between teardown and the new
    // query's first result, stale data would render as the WRONG query's
    // result. Consumers wanting keep-previous-data can hold their own copy.
    setData([]);
    setLoading(true);
    setError(null);
    const unsub = client.liveQuery<T>(
      slug,
      opts,
      (rows) => {
        setData(rows);
        setLoading(false);
      },
      (e) => {
        setError(e);
        setLoading(false);
      },
    );
    return unsub;
    // `key` captures slug+opts; `client` is the only other dep.
  }, [client, key]);

  return { data, loading, error };
}
