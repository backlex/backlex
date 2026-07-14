/**
 * Admin query layer — thin TanStack Query wrappers around the existing
 * `api.ts` clients.
 *
 * Goals:
 *   - Cache + dedupe identical reads (sidebar collection count, tenant
 *     switcher, members panel, etc. all hit the same endpoints; React Query
 *     coalesces them automatically).
 *   - Keep the existing `api.ts` typed surface — the hooks here just call
 *     those same functions, they aren't a new transport layer.
 *   - Make the query keys structured so cache invalidation after mutations
 *     can target whole subtrees (`["tenants"]` invalidates list + members +
 *     anything else nested under it).
 *
 * Migration playbook for callers:
 *   - `useEffect` + `useState` + `tenantsApi.list()` → `useTenants()`
 *   - Same for collections, roles, etc.
 *   - Mutations stay direct (e.g. `await tenantsApi.invite(...)`); follow
 *     with `queryClient.invalidateQueries({ queryKey: queryKeys.tenants() })`
 *     to refresh the relevant cache.
 *
 * Only the hooks the admin actually uses end up here — adding a new one when
 * a callsite migrates is preferable to pre-emptively exposing all 20+ API
 * surfaces and growing dead code.
 */
import { useEffect, useRef, useState } from "react";
import {
  type QueryKey,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  activityApi,
  advisorApi,
  type ApiCollection,
  type CollectionsLayoutInput,
  collectionsApi,
  accountApi,
  commentsApi,
  itemsApi,
  meApi,
  metricsApi,
  notificationsApi,
  rolesApi,
  settingsApi,
  sharedLinksApi,
  type TemplateCatalog,
  templatesApi,
  tenantsApi,
  tracesApi,
} from "./api";
import type { Post } from "./config";
import { type ItemsQueryParams, reconcileBulkUpdate } from "./items-query-params";

export {
  buildItemsParams,
  type ItemsQueryParams,
  reconcileBulkUpdate,
} from "./items-query-params";

export const queryKeys = {
  tenants: () => ["tenants"] as const,
  tenantMembers: (tenantId: string | null) => ["tenants", tenantId, "members"] as const,
  /** Keyed by the archived flag — active and archived are distinct cache
   *  entries so toggling the Collections-index view doesn't clobber the
   *  other list. `invalidateQueries({ queryKey: ["collections"] })` still
   *  matches both because the prefix is shared. */
  collections: (includeArchived = false) => ["collections", { includeArchived }] as const,
  /** Schema-template catalog (`/api/admin/templates`) — also carries
   *  `sampleSeeds`, the "Remove sample data" affordance's driver. */
  templates: () => ["templates"] as const,
  metricsOverview: (range: string) => ["metrics", "overview", range] as const,
  roles: () => ["roles"] as const,
  me: () => ["me"] as const,
  settings: () => ["settings"] as const,
  /** The signed-in user's own list-view columns (`/api/account/list-columns`). */
  myListColumns: () => ["my-list-columns"] as const,
  notifications: () => ["notifications"] as const,
  notificationsList: () => ["notifications", "list"] as const,
  notificationsUnread: () => ["notifications", "unread-count"] as const,
  /** Comment thread, keyed by (collection, itemId). The shared `["comments"]`
   *  prefix lets a single invalidate refresh every open thread. */
  comments: (collection: string, itemId: string) =>
    ["comments", collection, itemId] as const,
  /** Active public share links for a record, keyed by (collection, itemId). */
  sharedLinks: (collection: string, itemId: string) =>
    ["shared-links", collection, itemId] as const,
  advisor: () => ["advisor"] as const,
  /** Item list for a collection. The shared `["items", collection]` prefix is
   *  the rollback/invalidate scope for every filter/sort/search variant —
   *  optimistic mutations patch every cached variant of a collection through
   *  it without needing to know the exact active params. `params` (the third
   *  segment) is RQ-hashed stably so two equal filter sets share a cache entry. */
  items: (collection: string | null, params?: ItemsQueryParams) =>
    params
      ? (["items", collection, params] as const)
      : (["items", collection] as const),
  /** Activity log rows — the unified Logs page's data source. Keyed by the
   *  server-side filters (`from`, `action`, `pageSize`) so changing the time
   *  window or the action filter is a distinct cache entry; `offset` is the
   *  per-page cursor and lives in `useInfiniteQuery`'s page params, not here. */
  activity: (filters: ActivityFilters) => ["activity", filters] as const,
  /** Recent request traces (admin Traces page). Keyed by the server filters. */
  traces: (filters: TracesFilters) => ["traces", filters] as const,
  /** One trace's spans (waterfall detail). */
  trace: (traceId: string) => ["trace", traceId] as const,
};

/** Server-side filters that key the traces query. */
export interface TracesFilters {
  path?: string;
  minStatus?: number;
  limit?: number;
}

/** Server-side filters that key the activity infinite query. */
export interface ActivityFilters {
  /** Inclusive lower bound on `createdAt`, epoch ms (the time-range chip). */
  from?: number;
  /** Action namespace prefix (the category chip), e.g. `item` or `auth`. */
  action?: string;
  /** Rows per page request. */
  pageSize: number;
}

export function useTenants() {
  return useQuery({
    queryKey: queryKeys.tenants(),
    queryFn: () => tenantsApi.list(),
  });
}

export function useTenantMembers(tenantId: string | null) {
  return useQuery({
    queryKey: queryKeys.tenantMembers(tenantId),
    queryFn: () => {
      if (!tenantId) throw new Error("tenantId required");
      return tenantsApi.members(tenantId);
    },
    enabled: !!tenantId,
  });
}

/**
 * Collections list. `includeArchived` switches the endpoint to
 * `?include_archived=true` (adopted soft-delete rows) — the archived view
 * in the Collections index. Callers still filter by `status` themselves;
 * this only governs which rows the server returns.
 */
export function useCollections(includeArchived = false) {
  return useQuery({
    queryKey: queryKeys.collections(includeArchived),
    queryFn: () => collectionsApi.listWithArchived(includeArchived),
  });
}

/** Deterministic grouping used by both the Collections page and the sidebar
 *  tree: group order = the saved `groups` list (kept even when empty, so
 *  Edit-layout mode can render just-created groups — consumers filter empties
 *  where they don't want them), then any group names not in it (alphabetical),
 *  then ungrouped (`null`) last; within a group, `sortOrder` asc nulls-last,
 *  then `slug` asc. */
export function orderCollections<
  T extends { slug: string; group?: string | null; sortOrder?: number | null },
>(items: T[], groups: string[]): [string | null, T[]][] {
  const byGroup = new Map<string | null, T[]>();
  for (const it of items) {
    const g = it.group ?? null;
    const list = byGroup.get(g);
    if (list) list.push(it);
    else byGroup.set(g, [it]);
  }
  const unknown = [...byGroup.keys()]
    .filter((g): g is string => g !== null && !groups.includes(g))
    .sort((a, b) => a.localeCompare(b));
  const orderedKeys: (string | null)[] = [
    ...groups,
    ...unknown,
    ...(byGroup.has(null) ? [null] : []),
  ];
  const cmp = (a: T, b: T) => {
    const ao = a.sortOrder ?? null;
    const bo = b.sortOrder ?? null;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    return a.slug.localeCompare(b.slug);
  };
  return orderedKeys.map((g) => [g, [...(byGroup.get(g) ?? [])].sort(cmp)]);
}

/** Persist the whole Collections grouping/order layout (Edit layout mode).
 *  Optimistic: patches the RAW `{data, meta}` list-cache shape immediately,
 *  rolls back on error, reconciles with an invalidate. */
export function useSaveCollectionsLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CollectionsLayoutInput) => collectionsApi.saveLayout(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ["collections"] });
      const key = queryKeys.collections(false);
      const snap = qc.getQueryData(key);
      const bySlug = new Map(input.items.map((i) => [i.slug, i]));
      qc.setQueryData(
        key,
        (old: { data: ApiCollection[]; meta?: { groups: string[] } } | undefined) =>
          old && {
            ...old,
            data: old.data.map((c) => {
              const l = bySlug.get(c.slug);
              return l ? { ...c, group: l.group, sortOrder: l.sortOrder } : c;
            }),
            meta: { ...old.meta, groups: input.groups },
          },
      );
      return { snap };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) qc.setQueryData(queryKeys.collections(false), ctx.snap);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["collections"] }),
  });
}

/** Schema-template catalog. Shared by the Overview onboarding card, the
 *  Collections "From template" dialog and the sample-data callout — one cache
 *  entry, RQ dedupes the reads. */
export function useTemplatesCatalog(enabled = true) {
  return useQuery({
    queryKey: queryKeys.templates(),
    queryFn: () => templatesApi.list(),
    enabled,
  });
}

/** Remove every template-seeded sample row. Optimistic: the catalog cache's
 *  `sampleSeeds` zeroes immediately (hides the callout), restored on error. */
export function useClearTemplateSamples() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => templatesApi.clearSamples(),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: queryKeys.templates() });
      const snap = qc.getQueryData(queryKeys.templates());
      qc.setQueryData(
        queryKeys.templates(),
        (old: TemplateCatalog | undefined) => old && { ...old, sampleSeeds: 0 },
      );
      return { snap };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) qc.setQueryData(queryKeys.templates(), ctx.snap);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.templates() });
      // Seeded rows just disappeared from item lists + row counts.
      void qc.invalidateQueries({ queryKey: ["items"] });
      void qc.invalidateQueries({ queryKey: ["metrics"] });
    },
  });
}

/**
 * Admin metrics overview — used by the Collections index to enrich each
 * collection row with row counts / 24h write activity. Separate query so it
 * dedupes with any other consumer and refetches on its own cadence.
 */
export function useMetricsOverview(range = "24h") {
  return useQuery({
    queryKey: queryKeys.metricsOverview(range),
    queryFn: () => metricsApi.overview(range),
  });
}

export function useRoles() {
  return useQuery({
    queryKey: queryKeys.roles(),
    queryFn: () => rolesApi.list(),
  });
}

/** Workspace settings (`/api/admin/settings`) — includes `i18nLocales` /
 *  `i18nDefaultLocale`, which the item editor reads to render one input per
 *  language for `i18n_text` fields. Cached generously; languages rarely change. */
export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => settingsApi.load(),
    staleTime: 5 * 60 * 1000,
  });
}

/** The signed-in user's own per-collection list columns. Falls back to the
 *  workspace `listColumns` setting in `useListColumns` when a slug is absent. */
export function useMyListColumns() {
  return useQuery({
    queryKey: queryKeys.myListColumns(),
    queryFn: () => accountApi.getListColumns(),
    staleTime: 5 * 60 * 1000,
  });
}

/** Current signed-in user (`/api/me`). Used by the comment thread to decide
 *  which comments the caller may delete. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => meApi.get(),
    staleTime: 5 * 60 * 1000,
  });
}

/** In-app notification list for the header bell. */
export function useNotifications() {
  return useQuery({
    queryKey: queryKeys.notificationsList(),
    queryFn: () => notificationsApi.list({ limit: 50 }),
  });
}

/** Unread notification count — drives the red badge. Polls so the badge
 *  stays roughly fresh without a realtime channel. */
export function useNotificationsUnread() {
  return useQuery({
    queryKey: queryKeys.notificationsUnread(),
    queryFn: () => notificationsApi.unreadCount(),
    refetchInterval: 60 * 1000,
  });
}

/** Comment thread for a single item. Disabled until both ids are present. */
export function useComments(collection: string, itemId: string) {
  return useQuery({
    queryKey: queryKeys.comments(collection, itemId),
    queryFn: () => commentsApi.list(collection, itemId),
    enabled: !!collection && !!itemId,
  });
}

/** Active public share links for a single record. Disabled until both ids
 *  are present. */
export function useSharedLinks(collection: string, itemId: string) {
  return useQuery({
    queryKey: queryKeys.sharedLinks(collection, itemId),
    queryFn: () => sharedLinksApi.list(collection, itemId),
    enabled: !!collection && !!itemId,
  });
}

/** Advisor findings (`/api/admin/advisor`). Admin-only on the server. */
export function useAdvisor() {
  return useQuery({
    queryKey: queryKeys.advisor(),
    queryFn: () => advisorApi.list(),
  });
}

/**
 * Activity log rows — the data source for the unified Logs page.
 *
 * Uses `useInfiniteQuery` so the page can paginate past the 200-row server
 * cap: each page is a `limit`/`offset` request, and "Load more" appends the
 * next page. The time window (`from`) and the action category (`action`) are
 * pushed to the server (part of the query key) — this fixes the old bug where
 * a fixed 200-row `useQuery` clipped any range wider than the freshest 200
 * rows. `meta=count` is requested so the page can show a real total.
 *
 * `live` flips on a ~5s `refetchInterval` so the page can tail new entries.
 */
export function useActivity(filters: ActivityFilters, live = false) {
  return useInfiniteQuery({
    queryKey: queryKeys.activity(filters),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      activityApi.list({
        limit: filters.pageSize,
        offset: pageParam,
        from: filters.from,
        action: filters.action,
        meta: "count",
      }),
    // The next page exists only if the last page came back full. The cursor
    // is a running offset (previous offset + the page size we asked for).
    getNextPageParam: (lastPage, _all, lastOffset) =>
      lastPage.data.length === filters.pageSize
        ? lastOffset + filters.pageSize
        : undefined,
    refetchInterval: live ? 5000 : false,
  });
}

/** Recent request traces. `live` tails new traces on a ~5s interval. */
export function useTraces(filters: TracesFilters, live = false) {
  return useQuery({
    queryKey: queryKeys.traces(filters),
    queryFn: () =>
      tracesApi.list({
        path: filters.path,
        minStatus: filters.minStatus,
        limit: filters.limit ?? 50,
      }),
    refetchInterval: live ? 5000 : false,
  });
}

/** One trace's spans for the waterfall detail. Enabled only when open. */
export function useTrace(traceId: string | null) {
  return useQuery({
    queryKey: queryKeys.trace(traceId ?? ""),
    queryFn: () => tracesApi.get(traceId as string),
    enabled: !!traceId,
  });
}

// ---------------------------------------------------------------------------
// Items list + optimistic mutation layer
//
// The admin item list used to be a hand-rolled `useState` + manual fetch in
// app.tsx; mutations poked that array directly and `refresh()` did nothing.
// It now lives in React Query: `useItems` owns the read, and the mutation
// hooks below own optimistic writes — they snapshot the cache, patch it
// immediately, roll back on error, reconcile the authoritative server row on
// success, and invalidate on settle. Every write is scoped to the shared
// `["items", collection]` prefix so whichever filtered variant is on screen
// (plus any other cached one) updates together.
// ---------------------------------------------------------------------------

/** `ItemsQueryParams` is already the URL query shape — optional keys are simply
 *  absent (never `undefined`), so it's safe to hand straight to `itemsApi.list`. */
function paramsToQuery(params: ItemsQueryParams): Record<string, string | number> {
  return params as unknown as Record<string, string | number>;
}

/**
 * Item list for the active collection. The queryFn flattens the envelope to a
 * `Post[]` so the CACHE itself holds the array — that's what the optimistic
 * mutation helpers below snapshot and patch (a `select` would only transform
 * the value handed to the component, leaving the cached envelope untouched, and
 * `rows.map` would blow up inside the updaters). `placeholderData` keeps the
 * previous rows while only the PARAMS change (typing / filtering / sorting → no
 * skeleton flash), but drops to `undefined` when the COLLECTION changes so the
 * items skeleton shows — this reproduces the old `setItemsLoaded(false)` on
 * collection switch.
 */
export function useItems(collection: string | null, params: ItemsQueryParams) {
  return useQuery({
    queryKey: queryKeys.items(collection, params),
    queryFn: async () => {
      const res = await itemsApi.list(collection as string, paramsToQuery(params));
      return (Array.isArray(res.data) ? res.data : []) as unknown as Post[];
    },
    enabled: !!collection,
    placeholderData: (prev, prevQuery) =>
      prevQuery && (prevQuery.queryKey as QueryKey)[1] === collection ? prev : undefined,
    staleTime: 10_000,
  });
}

/**
 * Make the items list a *reactive query*: subscribe to the collection's
 * realtime feed (`items:<slug>`) and refresh the cached list whenever a row
 * changes — including writes from other tabs, other admins, the SDK, or a
 * flow. This is the server-stateless "refetch mode" of the SDK's `liveQuery`
 * (the SDK ships the incremental engine for app consumers); here, RQ owns the
 * cache + optimistic writes, so an event just debounce-invalidates the active
 * collection's queries and RQ refetches the exact, permission-filtered window.
 *
 * Returns a `live` flag (true while the SSE channel is connected) for a UI
 * indicator. No-ops when realtime isn't available (the EventSource just errors
 * and the list stays at its last fetched state — still correct, just not live).
 */
export function useLiveCollection(collection: string | null): { live: boolean } {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLive(false);
    if (!collection) return;
    if (typeof EventSource === "undefined") return;
    const base = import.meta.env.VITE_API_URL ?? "";
    const url = `${base}/api/realtime/items:${encodeURIComponent(collection)}/subscribe`;
    const es = new EventSource(url, { withCredentials: true });

    const bump = () => {
      if (timer.current) clearTimeout(timer.current);
      // Coalesce bursts (a batch write fires many row events) into one refetch.
      timer.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["items", collection] });
      }, 150);
    };

    es.addEventListener("open", () => setLive(true));
    es.addEventListener("message", bump);
    es.addEventListener("error", () => setLive(false));

    return () => {
      if (timer.current) clearTimeout(timer.current);
      es.close();
      setLive(false);
    };
  }, [collection, qc]);

  return { live };
}

// --- shared cache-mutation helpers (module-private) ------------------------

/** Snapshot every cached list variant for a collection, for rollback. */
type ItemsSnapshot = [QueryKey, Post[] | undefined][];

function snapshotItems(qc: ReturnType<typeof useQueryClient>, collection: string): ItemsSnapshot {
  return qc.getQueriesData<Post[]>({ queryKey: ["items", collection] }) as ItemsSnapshot;
}

function restoreItems(qc: ReturnType<typeof useQueryClient>, snap: ItemsSnapshot) {
  for (const [key, data] of snap) qc.setQueryData(key, data);
}

/** Apply `fn` to every cached list variant for a collection. */
function patchItemRows(
  qc: ReturnType<typeof useQueryClient>,
  collection: string,
  fn: (rows: Post[]) => Post[],
) {
  qc.setQueriesData<Post[]>({ queryKey: ["items", collection] }, (old) =>
    old ? fn(old) : old,
  );
}

function invalidateItems(qc: ReturnType<typeof useQueryClient>, collection: string) {
  void qc.invalidateQueries({ queryKey: ["items", collection] });
}

const nowIso = () => new Date().toISOString();

// --- mutation hooks (one per write area) -----------------------------------

/** Inline / single-field edit, toggles, Kanban status, sheet edit. Optimistic
 *  merge; `mutateAsync` resolves the server row so callers can re-sync. */
export function useItemPatch(collection: string | null) {
  const qc = useQueryClient();
  const slug = collection || "posts";
  return useMutation({
    mutationFn: (vars: { id: string; patch: Record<string, unknown> }) =>
      itemsApi.patch(slug, vars.id, vars.patch),
    onMutate: (vars) => {
      const snap = snapshotItems(qc, slug);
      const now = nowIso();
      patchItemRows(qc, slug, (rows) =>
        rows.map((r) => (r.id === vars.id ? ({ ...r, ...vars.patch, updated_at: now } as Post) : r)),
      );
      return { snap };
    },
    onError: (_e, _v, ctx) => ctx && restoreItems(qc, ctx.snap),
    onSettled: () => invalidateItems(qc, slug),
  });
}

/** Sheet create. Prepends an optimistic row under a temp id, then swaps in the
 *  server row on success (temp-id reconciliation). */
export function useItemCreate(collection: string | null) {
  const qc = useQueryClient();
  const slug = collection || "posts";
  return useMutation({
    mutationFn: (vars: { draft: Record<string, unknown>; tempId: string }) =>
      itemsApi.create(slug, vars.draft),
    onMutate: (vars) => {
      const snap = snapshotItems(qc, slug);
      const optimistic = {
        id: vars.tempId,
        updated_at: nowIso(),
        view_count: 0,
        word_count: 0,
        published_at: null,
        title: "",
        slug: "",
        status: "draft",
        author: "u_1",
        ...(vars.draft as Partial<Post>),
      } as Post;
      patchItemRows(qc, slug, (rows) => [optimistic, ...rows]);
      return { snap };
    },
    onError: (_e, _v, ctx) => ctx && restoreItems(qc, ctx.snap),
    onSuccess: (res, vars) => {
      const serverRow = res.data as unknown as Post;
      patchItemRows(qc, slug, (rows) =>
        rows.map((r) => (r.id === vars.tempId ? ({ ...r, ...serverRow } as Post) : r)),
      );
    },
    onSettled: () => invalidateItems(qc, slug),
  });
}

/** Single delete (editor, or any future row action). Removes the row
 *  immediately; restores on error. */
export function useItemDelete(collection: string | null) {
  const qc = useQueryClient();
  const slug = collection || "posts";
  return useMutation({
    mutationFn: (vars: { id: string }) => itemsApi.remove(slug, vars.id),
    onMutate: (vars) => {
      const snap = snapshotItems(qc, slug);
      patchItemRows(qc, slug, (rows) => rows.filter((r) => r.id !== vars.id));
      return { snap };
    },
    onError: (_e, _v, ctx) => ctx && restoreItems(qc, ctx.snap),
    onSettled: () => invalidateItems(qc, slug),
  });
}

/** Publish / unpublish / schedule a versioned item. Optimistic-light flip of
 *  the obvious display fields, then reconcile authoritative server fields. */
export function useItemPublish(collection: string | null) {
  const qc = useQueryClient();
  const slug = collection || "posts";
  return useMutation({
    mutationFn: (vars: { id: string; action: "publish" | "unpublish" | "archive" | "schedule"; publishAt?: string | null }) =>
      vars.action === "publish"
        ? itemsApi.publish(slug, vars.id)
        : vars.action === "unpublish"
          ? itemsApi.unpublish(slug, vars.id)
          : vars.action === "archive"
            ? itemsApi.archive(slug, vars.id)
            : itemsApi.schedulePublish(slug, vars.id, vars.publishAt ?? null),
    onMutate: (vars) => {
      const snap = snapshotItems(qc, slug);
      const now = nowIso();
      // Flip both the display alias (`status`/`published_at`) and the raw
      // system columns (`_status`/`_published_at`) so every surface moves
      // optimistically — the list badge reads `status`, the Kanban lifecycle
      // board groups on the raw `_status`.
      const flip =
        vars.action === "publish"
          ? { status: "published", published_at: now, _status: "published", _published_at: now }
          : vars.action === "unpublish"
            ? { status: "draft", _status: "draft", _published_at: null }
            : vars.action === "archive"
              ? { status: "archived", _status: "archived", _published_at: null }
              : {};
      patchItemRows(qc, slug, (rows) =>
        rows.map((r) => (r.id === vars.id ? ({ ...r, ...flip, updated_at: now } as Post) : r)),
      );
      return { snap };
    },
    onError: (_e, _v, ctx) => ctx && restoreItems(qc, ctx.snap),
    onSuccess: (res, vars) => {
      const serverRow = res.data as Partial<Post>;
      patchItemRows(qc, slug, (rows) =>
        rows.map((r) => (r.id === vars.id ? ({ ...r, ...serverRow } as Post) : r)),
      );
    },
    onSettled: () => invalidateItems(qc, slug),
  });
}

/** Bulk field update — partial-success aware. Optimistically patches every
 *  selected id, then on success reverts to the snapshot and re-applies only
 *  the ids the server confirmed. Resolves the server payload for toasts. */
export function useItemsBulkUpdate(collection: string | null) {
  const qc = useQueryClient();
  const slug = collection || "posts";
  return useMutation({
    mutationFn: (vars: { ids: string[]; data: Record<string, unknown> }) =>
      itemsApi.bulkUpdate(slug, vars.ids, vars.data),
    onMutate: (vars) => {
      const snap = snapshotItems(qc, slug);
      const now = nowIso();
      const ids = new Set(vars.ids);
      patchItemRows(qc, slug, (rows) =>
        rows.map((r) => (ids.has(r.id) ? ({ ...r, ...vars.data, updated_at: now } as Post) : r)),
      );
      return { snap };
    },
    onError: (_e, _v, ctx) => ctx && restoreItems(qc, ctx.snap),
    onSuccess: (res, vars, ctx) => {
      if (!ctx) return;
      const okIds = new Set(res.data.results.filter((x) => x.ok).map((x) => x.id));
      restoreItems(qc, ctx.snap);
      const now = nowIso();
      patchItemRows(qc, slug, (rows) => reconcileBulkUpdate(rows, okIds, vars.data, now));
    },
    onSettled: () => invalidateItems(qc, slug),
  });
}

/** Bulk publish via `Promise.allSettled` — partial-success aware. Returns
 *  `{ okIds, failed }` so callers can toast the counts. */
export function useItemsBulkPublish(collection: string | null) {
  const qc = useQueryClient();
  const slug = collection || "posts";
  return useMutation({
    mutationFn: async (vars: { ids: string[] }) => {
      const settled = await Promise.allSettled(vars.ids.map((id) => itemsApi.publish(slug, id)));
      const okIds = vars.ids.filter((_, i) => settled[i]?.status === "fulfilled");
      return { okIds, failed: vars.ids.length - okIds.length };
    },
    onMutate: (vars) => {
      const snap = snapshotItems(qc, slug);
      const now = nowIso();
      const ids = new Set(vars.ids);
      patchItemRows(qc, slug, (rows) =>
        rows.map((r) =>
          ids.has(r.id)
            ? ({ ...r, status: "published", published_at: now, updated_at: now } as Post)
            : r,
        ),
      );
      return { snap };
    },
    onError: (_e, _v, ctx) => ctx && restoreItems(qc, ctx.snap),
    onSuccess: (res, _vars, ctx) => {
      if (!ctx) return;
      const okIds = new Set(res.okIds);
      restoreItems(qc, ctx.snap);
      const now = nowIso();
      patchItemRows(qc, slug, (rows) =>
        rows.map((r) =>
          okIds.has(r.id)
            ? ({ ...r, status: "published", published_at: now, updated_at: now } as Post)
            : r,
        ),
      );
    },
    onSettled: () => invalidateItems(qc, slug),
  });
}

/** Bulk delete via `Promise.allSettled` — partial-success aware. Removes all
 *  ids optimistically, then re-inserts any the server failed to delete.
 *  Returns `{ okIds, failed }`. */
export function useItemsBulkDelete(collection: string | null) {
  const qc = useQueryClient();
  const slug = collection || "posts";
  return useMutation({
    mutationFn: async (vars: { ids: string[] }) => {
      const settled = await Promise.allSettled(vars.ids.map((id) => itemsApi.remove(slug, id)));
      const okIds = vars.ids.filter((_, i) => settled[i]?.status === "fulfilled");
      return { okIds, failed: vars.ids.length - okIds.length };
    },
    onMutate: (vars) => {
      const snap = snapshotItems(qc, slug);
      const ids = new Set(vars.ids);
      patchItemRows(qc, slug, (rows) => rows.filter((r) => !ids.has(r.id)));
      return { snap };
    },
    onError: (_e, _v, ctx) => ctx && restoreItems(qc, ctx.snap),
    onSuccess: (res, _vars, ctx) => {
      if (!ctx) return;
      // Only the ids that actually failed should reappear.
      const okIds = new Set(res.okIds);
      restoreItems(qc, ctx.snap);
      patchItemRows(qc, slug, (rows) => rows.filter((r) => !okIds.has(r.id)));
    },
    onSettled: () => invalidateItems(qc, slug),
  });
}
