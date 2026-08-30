/**
 * A hash router in thirty lines. The app needs deep links to a product and an
 * order; it does not need a routing library to get them.
 */
import { useCallback, useEffect, useState } from "react";

export function useRoute(): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#/, "") || "/";
  const [path, setPath] = useState(read);
  useEffect(() => {
    const on = () => setPath(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((to: string) => {
    window.location.hash = to;
  }, []);
  return [path, go];
}

/** `/products/abc` → `["products", "abc"]`. */
export function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}
