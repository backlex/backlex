// Warmers for the lazy admin page chunks, keyed by nav id.
//
// Two callers share this: the sidebar warms a page's chunk on hover/focus
// (intent), and the view-transition navigate awaits it so the transition
// snapshots the real page instead of the Suspense skeleton. Vite resolves
// these specifiers to the same modules the `lazy()` calls in app.tsx load, so
// warming here populates the same chunk cache. Pages not listed are rendered
// inline (no lazy boundary) and need no prefetch.

const LOADERS: Record<string, () => Promise<unknown>> = {
  overview: () => import("../pages/overview"),
  "ask-ai": () => import("../pages/ask-ai"),
  flows: () => import("../pages/automation/flows"),
  functions: () => import("../pages/automation/functions"),
  jobs: () => import("../pages/automation/jobs"),
  "feature-flags": () => import("../pages/automation/feature-flags"),
  webhooks: () => import("../pages/automation/webhooks"),
  integrations: () => import("../pages/automation/integrations"),
  payments: () => import("../pages/automation/payments"),
  realtime: () => import("../pages/automation/realtime"),
  logs: () => import("../pages/observability/logs"),
  advisor: () => import("../pages/observability/advisor"),
  "tag-manager": () => import("../pages/observability/tag-manager"),
  "schema-graph": () => import("../pages/data/schema-graph"),
  users: () => import("../pages/access/users"),
  settings: () => import("../pages/settings"),
  extensions: () => import("../pages/developers/extensions"),
  "rest-explorer": () => import("@/pages/rest-explorer"),
};

// Each chunk is fetched at most once; repeat calls return the in-flight/settled
// promise so hover-spamming a nav item is free.
const started = new Map<string, Promise<unknown>>();

/**
 * Begin loading the chunk for `navId` (idempotent). Returns the load promise so
 * a caller can wait for it, or `undefined` when the page has no lazy chunk.
 */
export function prefetchPage(navId: string): Promise<unknown> | undefined {
  const loader = LOADERS[navId];
  if (!loader) return undefined;
  let pending = started.get(navId);
  if (!pending) {
    pending = loader().catch(() => {});
    started.set(navId, pending);
  }
  return pending;
}
