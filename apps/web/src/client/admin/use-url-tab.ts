import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

/**
 * The path as decoded segments.
 *
 * Decoded because browsers percent-encode `:` in the first segment (scheme
 * ambiguity), so an extension panel visited directly arrives as
 * `/ext%3Aname%3Apanel` — the same reason the router in `app.tsx` decodes. A
 * segment that is not valid encoding is kept as-is rather than throwing.
 */
const segmentsOf = (pathname: string): string[] =>
  pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

/**
 * A page's open tab, held in the path instead of in component state.
 *
 * Every tabbed admin page wants the same four things, and a `useState` gives
 * none of them: a refresh comes back where it was, a link can point at a panel,
 * the back button works, and a page that is *watched* — bookings arriving,
 * submissions landing — can be re-read without the reload that would have
 * closed it. Before this the answer was written out by hand three times (auth
 * settings, booking, forms) and left in state on nine other pages, which is
 * exactly how three spellings of one idea start drifting apart.
 *
 * The tab is a path segment rather than a query parameter because it names
 * *which page you are on*, not how one is filtered — the same reason the open
 * collection and the open flow are segments.
 *
 * `depth` is which segment holds it. Pages hung straight off a nav id leave it
 * at 1 (`/settings/general`); a page that opens a record first passes 2
 * (`/collections/posts/schema`, `/booking/clinic/questions`).
 *
 * An unreadable tab reads as the fallback rather than rendering nothing, so a
 * truncated or hand-typed URL still opens the page. A URL with no tab segment
 * at all is left as it is rather than rewritten to the default: `/settings` is
 * a fair way to say "settings", and canonicalising it would put a history entry
 * between the operator and wherever they came from.
 */
export function useUrlTab<T extends string>(
  tabs: readonly T[],
  fallback: T,
  depth = 1,
): [T, (next: T, opts?: { replace?: boolean }) => void] {
  const location = useLocation();
  const navigate = useNavigate();

  const raw = segmentsOf(location.pathname)[depth];
  const tab = raw !== undefined && (tabs as readonly string[]).includes(raw) ? (raw as T) : fallback;

  const setTab = useCallback(
    /**
     * `replace` is for the page moving itself, not the operator moving: a tab
     * that empties out from under someone has to send them somewhere, and
     * pushing that would leave a back button that lands on the dead tab and
     * bounces again.
     */
    (next: T, opts?: { replace?: boolean }) => {
      const current = segmentsOf(location.pathname);
      const base = current.slice(0, depth);
      // The segments the tab hangs off are not all there — no record is open,
      // so there is no page for this to be a tab of.
      if (base.length < depth) return;
      // Already there. Clicking the open tab should not cost a history entry.
      if (current[depth] === next) return;
      navigate("/" + [...base, next].map(encodeURIComponent).join("/"), {
        replace: opts?.replace === true,
      });
    },
    [location.pathname, depth, navigate],
  );

  return [tab, setTab];
}
