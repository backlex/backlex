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
  const start = (document as Document & {
    startViewTransition: StartViewTransition;
  }).startViewTransition;
  const transition = start(() => {
    flushSync(commit);
  });
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (direction && root.dataset.vt === direction) delete root.dataset.vt;
    });
}
