// View Transitions helper for the admin SPA.
//
// React 19.2 (stable) does NOT ship the `<ViewTransition>` component — it's
// experimental-channel only — and React Router 8's built-in `viewTransition`
// navigation only runs under the data router (`createBrowserRouter`), not the
// declarative `<BrowserRouter>` this app uses. So we drive the browser's native
// View Transitions API ourselves: wrap the route commit in
// `document.startViewTransition` and `flushSync` it so the API captures the
// post-navigation DOM. CSS in admin.css owns the actual animation
// (scoped to the `main-pane` named transition; the sidebar/topbar stay static).

import { flushSync } from "react-dom";
import { useEffect } from "react";
import { useNavigate } from "react-router";

export type ViewTransitionDirection = "forward" | "back";

type StartViewTransition = (cb: () => void) => { finished: Promise<void> };

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function supportsViewTransitions(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as Document & { startViewTransition?: unknown })
      .startViewTransition === "function"
  );
}

/**
 * Run `commit` (a navigation / state update) inside a browser View Transition.
 *
 * `commit` is flushed synchronously so `startViewTransition` snapshots the new
 * DOM rather than the pre-update one. Falls back to a plain `commit()` when the
 * API is unavailable or the user prefers reduced motion. `direction` tags
 * `<html data-vt="…">` so CSS can swap in a directional keyframe; the attribute
 * is removed once the transition settles (or is skipped).
 */
export function withViewTransition(
  commit: () => void,
  direction?: ViewTransitionDirection,
): void {
  if (!supportsViewTransitions() || prefersReducedMotion()) {
    commit();
    return;
  }
  const root = document.documentElement;
  if (direction) root.dataset.vt = direction;
  // Must be invoked on `document` — extracting the method into a bare variable
  // and calling it unbound throws "Illegal invocation" (native receiver check).
  const doc = document as Document & {
    startViewTransition: StartViewTransition;
  };
  const transition = doc.startViewTransition(() => {
    flushSync(commit);
  });
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (direction && root.dataset.vt === direction) delete root.dataset.vt;
    });
}

function isInternalLink(a: HTMLAnchorElement): boolean {
  const href = a.getAttribute("href");
  return (
    !!href &&
    href.startsWith("/") &&
    !href.startsWith("//") &&
    a.getAttribute("target") !== "_blank" &&
    !a.hasAttribute("download") &&
    // Opt-out hook for any link that should navigate without a transition.
    a.dataset.noVt === undefined
  );
}

/**
 * App-wide view transitions for EVERY in-app anchor click — in-page links,
 * breadcrumbs, route tabs — via one capture-phase listener instead of wrapping
 * each `<Link>`. preventDefault'ing in capture makes React Router's own Link
 * handler bail, then we navigate inside a transition. The sidebar (which uses
 * buttons + the explicit `vNav` helper, not anchors) is unaffected, so there's
 * no double-wrapping. `prefetch` (optional) warms a destination on hover.
 */
export function useLinkViewTransitions(prefetch?: (href: string) => void): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onClick = (e: MouseEvent) => {
      // Reduced-motion / unsupported: let React Router handle it normally.
      if (!supportsViewTransitions() || prefersReducedMotion()) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest("a");
      if (!a || !isInternalLink(a)) return;
      const href = a.getAttribute("href")!;
      e.preventDefault();
      if (href === window.location.pathname + window.location.search) return;
      withViewTransition(() => navigate(href));
    };
    const onOver = (e: Event) => {
      if (!prefetch) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (a && isInternalLink(a)) prefetch(a.getAttribute("href")!);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointerover", onOver, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerover", onOver, true);
    };
  }, [navigate, prefetch]);
}

// ─── Scroll restoration ───
// The admin's scroll container (`.scrollarea`) stays mounted across every
// navigation, so its scrollTop would otherwise leak between views (e.g. an item
// editor opening at the list's scroll offset). We keep a per-URL position map:
// save on the way out, restore on arrival (default = top). This both fixes the
// leak and gives free "back to list restores your place" behaviour — what
// react-router's <ScrollRestoration> does, which only works under the data
// router this app doesn't use.
const PANE_SELECTOR = ".scrollarea";
const scrollByKey = new Map<string, number>();

function pane(): HTMLElement | null {
  return typeof document !== "undefined"
    ? document.querySelector<HTMLElement>(PANE_SELECTOR)
    : null;
}

/** Remember the current scroll offset for `key` (the location being left). */
export function savePaneScroll(key: string): void {
  const el = pane();
  if (el) scrollByKey.set(key, el.scrollTop);
}

/** Restore the saved offset for `key` (the location arrived at), or scroll to
 *  the top when it has never been visited. */
export function restorePaneScroll(key: string): void {
  const el = pane();
  if (el) el.scrollTop = scrollByKey.get(key) ?? 0;
}
