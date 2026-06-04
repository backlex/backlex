import { useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Two-way bind a single search-param key to React state.
 * - Reads the current value on every render (so back/forward updates the UI).
 * - Writes with `replace: true` so each keystroke doesn't fill history.
 * - Omitting the param when value === defaultValue keeps URLs clean.
 */
export function useUrlState(
  key: string,
  defaultValue: string,
): [string, (next: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? defaultValue;
  const set = (next: string) => {
    const np = new URLSearchParams(params);
    if (next === defaultValue || next === "") np.delete(key);
    else np.set(key, next);
    setParams(np, { replace: true });
  };
  return [value, set];
}

/** JSON-typed variant for arrays/objects (e.g. filters[]). */
export function useUrlStateJson<T>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  // Keep a stable default reference across renders so the memo below can
  // fall back to the same object identity when the param is absent.
  const defaultRef = useRef(defaultValue);
  // Memoize the parse on the raw URL string. Without this, every render
  // produces a fresh `JSON.parse` (or fresh `[]` default) reference, which
  // turns any effect/queryKey depending on the returned value into an
  // infinite refetch loop (see the items effect in admin/app.tsx).
  const value = useMemo<T>(() => {
    if (!raw) return defaultRef.current;
    try {
      return JSON.parse(raw) as T;
    } catch {
      /* malformed → default */
      return defaultRef.current;
    }
  }, [raw]);
  const set = (next: T) => {
    const np = new URLSearchParams(params);
    const isEmpty =
      next == null ||
      (Array.isArray(next) && next.length === 0) ||
      (typeof next === "object" && Object.keys(next as object).length === 0);
    if (isEmpty) np.delete(key);
    else np.set(key, JSON.stringify(next));
    setParams(np, { replace: true });
  };
  return [value, set];
}
