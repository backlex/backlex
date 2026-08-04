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
  type ApiExtension,
  type CollectionsLayoutInput,
  collectionsApi,
  accountApi,
  commentsApi,
  extensionsApi,
  itemsApi,
  analyticsApi,
  type ApiErrorGroup,
  type ApiErrorGroupDetail,
  type ApiErrorStatus,
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
  usageApi,
} from "./api";
import { reorderVisible } from "@backlex/db/order";
import type { Post } from "./config";
import { type ItemsQueryParams, reconcileBulkUpdate } from "./items-query-params";
import { itemsTransport, openSignalPipe } from "./signal";

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
  /** Advisor run. Called with no argument this is the `["advisor"]` prefix
   *  every advisor query (including insights) sits under, so invalidating it
   *  refreshes findings and insights together after an applied fix. */
  advisor: (days?: number) =>
    days === undefined ? (["advisor"] as const) : (["advisor", days] as const),
  advisorInsights: (days: number) => ["advisor", "insights", days] as const,
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
  /** Usage-metering overview (admin Usage page). Keyed by the series window. */
  usage: (days: number) => ["usage", days] as const,
  /** Product-analytics overview (admin Analytics page). Keyed by the window. */
  analytics: (days: number) => ["analytics", "overview", days] as const,
  /** Tracked event names — the funnel builder's step vocabulary. */
  analyticsEventNames: () => ["analytics", "event-names"] as const,
  /** A funnel run. Keyed by its steps + window so switching back is instant. */
  analyticsFunnel: (steps: string[], windowDays: number, days: number) =>
    ["analytics", "funnel", steps, windowDays, days] as const,
  /** A retention run, keyed by the optional activity event + window. */
  analyticsRetention: (event: string | null, days: number) =>
    ["analytics", "retention", event, days] as const,
  /** Crash groups. Shares the `["errors"]` prefix with the detail query so one
   *  invalidate refreshes the list and any open group. */
  errorGroups: (status: string, level: string) =>
    ["errors", "list", status, level] as const,
  /** One crash group's detail (stacks, series, affected visitors). */
  errorGroup: (id: string) => ["errors", "detail", id] as const,
  /** Whether a publishable ingest key exists. */
  analyticsIngestKey: () => ["analytics", "ingest-key"] as const,
  /** Enabled extensions — drives dynamic sidebar panels + extension field
   *  editors. Shares the `["extensions"]` prefix with the admin page's list
   *  query so one invalidate refreshes both. */
  extensionsEnabled: () => ["extensions", "enabled"] as const,
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

/** Clone a collection's schema into a new slug. Optimistic: a placeholder row
 *  (the source with the new slug) lands in the list cache immediately, then the
 *  settled invalidate swaps in the canonical server row; errors roll back. */
export function useCloneCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, newSlug }: { slug: string; newSlug: string }) =>
      collectionsApi.clone(slug, newSlug),
    onMutate: async ({ slug, newSlug }) => {
      await qc.cancelQueries({ queryKey: ["collections"] });
      const key = queryKeys.collections(false);
      const snap = qc.getQueryData(key);
      qc.setQueryData(
        key,
        (old: { data: ApiCollection[]; meta?: { groups: string[] } } | undefined) => {
          if (!old) return old;
          const src = old.data.find((c) => c.slug === slug);
          if (!src || old.data.some((c) => c.slug === newSlug)) return old;
          return { ...old, data: [...old.data, { ...src, slug: newSlug, sortOrder: null }] };
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
 *  language for `localized` fields. Cached generously; languages rarely change. */
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

/** Advisor findings (`/api/admin/advisor`). Admin-only on the server.
 *  `days` is the window the traffic-derived performance rules aggregate over;
 *  omitting it takes the server default (7). */
export function useAdvisor(days?: number) {
  return useQuery({
    queryKey: queryKeys.advisor(days),
    queryFn: () => advisorApi.list(days),
  });
}

/** Runtime query insights (`/api/admin/advisor/insights`) — the aggregation
 *  the traffic-derived rules are computed from. Admin-only on the server. */
export function useAdvisorInsights(days: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.advisorInsights(days),
    queryFn: () => advisorApi.insights(days),
    enabled,
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

/**
 * Enabled extensions (`GET /api/extensions/enabled`) — the source for dynamic
 * sidebar panels, the item-form field-editor injection, and the interface
 * picker's "Extensions" group. The endpoint only needs a signed-in session, so
 * the hook is safe for non-admins; any failure (older server, network, 401
 * race) resolves to an empty list so every consumer degrades to the built-in
 * behaviour instead of throwing.
 */
export function useEnabledExtensions() {
  return useQuery({
    queryKey: queryKeys.extensionsEnabled(),
    queryFn: async (): Promise<{ data: ApiExtension[] }> => {
      try {
        return await extensionsApi.enabled();
      } catch {
        return { data: [] };
      }
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Usage-metering overview for the admin Usage page. */
export function useUsageOverview(days: number) {
  return useQuery({
    queryKey: queryKeys.usage(days),
    queryFn: () => usageApi.overview(days),
  });
}

// ---------------------------------------------------------------------------
// Product analytics + crash reporting (#22)
//
// Reads are plain queries keyed by their window so flipping between 7/30/90
// days is instant on the way back. The triage mutations are optimistic: a
// resolve/ignore must repaint the row before the round-trip, and roll back if
// the server refuses.
// ---------------------------------------------------------------------------

/** Turn a day window into the inclusive epoch-ms range the API takes. */
const analyticsRange = (days: number) => {
  const to = Date.now();
  return { from: to - days * 86_400_000, to };
};

export function useAnalyticsOverview(days: number) {
  return useQuery({
    queryKey: queryKeys.analytics(days),
    queryFn: () => {
      const { from, to } = analyticsRange(days);
      return analyticsApi.overview(from, to);
    },
  });
}

/** Event-name vocabulary for the funnel builder's step pickers. */
export function useAnalyticsEventNames() {
  return useQuery({
    queryKey: queryKeys.analyticsEventNames(),
    queryFn: () => analyticsApi.eventNames(),
  });
}

/** A funnel run. Disabled until at least two steps are chosen. */
export function useAnalyticsFunnel(steps: string[], windowDays: number, days: number) {
  return useQuery({
    queryKey: queryKeys.analyticsFunnel(steps, windowDays, days),
    queryFn: () => {
      const { from, to } = analyticsRange(days);
      return analyticsApi.funnel({ steps, windowDays, from, to });
    },
    enabled: steps.length >= 2,
  });
}

export function useAnalyticsRetention(event: string | null, days: number) {
  return useQuery({
    queryKey: queryKeys.analyticsRetention(event, days),
    queryFn: () => {
      const { from, to } = analyticsRange(days);
      return analyticsApi.retention({ event, from, to });
    },
  });
}

export function useErrorGroups(status: string, level: string) {
  return useQuery({
    queryKey: queryKeys.errorGroups(status, level),
    queryFn: () =>
      analyticsApi.errors({
        status: status === "all" ? undefined : status,
        level: level === "all" ? undefined : level,
        limit: 100,
      }),
  });
}

/** One group's stacks + series. Enabled only while the detail sheet is open. */
export function useErrorGroup(id: string | null) {
  return useQuery({
    queryKey: queryKeys.errorGroup(id ?? ""),
    queryFn: () => analyticsApi.error(id as string),
    enabled: !!id,
  });
}

export function useAnalyticsIngestKey() {
  return useQuery({
    queryKey: queryKeys.analyticsIngestKey(),
    queryFn: () => analyticsApi.ingestKeyStatus(),
  });
}

/** Triage a crash group. Repaints the row (and any open detail) immediately. */
export function useUpdateErrorGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: ApiErrorStatus }) =>
      analyticsApi.updateError(id, status),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ["errors"] });
      const snap = qc.getQueriesData({ queryKey: ["errors"] });
      qc.setQueriesData(
        { queryKey: ["errors", "list"] },
        (old: { data: ApiErrorGroup[] } | undefined) =>
          old && {
            ...old,
            data: old.data.map((g) => (g.id === id ? { ...g, status } : g)),
          },
      );
      qc.setQueryData(
        queryKeys.errorGroup(id),
        (old: { data: ApiErrorGroupDetail } | undefined) =>
          old && { ...old, data: { ...old.data, group: { ...old.data.group, status } } },
      );
      return { snap };
    },
    onError: (_e, _vars, ctx) => {
      for (const [key, data] of ctx?.snap ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["errors"] });
    },
  });
}

/** Delete a crash group. Drops the row optimistically, restores on failure. */
export function useDeleteErrorGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => analyticsApi.deleteError(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["errors"] });
      const snap = qc.getQueriesData({ queryKey: ["errors"] });
      qc.setQueriesData(
        { queryKey: ["errors", "list"] },
        (old: { data: ApiErrorGroup[] } | undefined) =>
          old && { ...old, data: old.data.filter((g) => g.id !== id) },
      );
      return { snap };
    },
    onError: (_e, _vars, ctx) => {
      for (const [key, data] of ctx?.snap ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["errors"] });
    },
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
 * Two pipes, one behaviour. `GET /api/realtime/items-config` picks:
 *  - `sse` — the held `items:*` stream (Durable Object, Bun, or the Upstash
 *    long-poll). Every event is a bump.
 *  - `ably-signal` — stateless serverless: id-only signals over Ably, which the
 *    browser receives directly. Same bump, zero function invocations.
 * Either way the payload is irrelevant here — RQ refetches the real window.
 *
 * Returns a `live` flag (true while the channel is connected) for a UI
 * indicator. No-ops when realtime isn't available (the list stays at its last
 * fetched state — still correct, just not live).
 */
export function useLiveCollection(collection: string | null): { live: boolean } {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLive(false);
    if (!collection) return;
    let disposed = false;
    let stop: (() => void) | null = null;

    const bump = () => {
      if (timer.current) clearTimeout(timer.current);
      // Coalesce bursts (a batch write fires many row events) into one refetch.
      timer.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["items", collection] });
      }, 150);
    };

    void (async () => {
      const transport = await itemsTransport();
      if (disposed) return;
      if (transport === "ably-signal") {
        const close = await openSignalPipe(collection, bump);
        if (disposed || !close) {
          close?.();
          return;
        }
        setLive(true);
        stop = () => {
          setLive(false);
          close();
        };
        return;
      }
      if (transport === "off") return;
      if (typeof EventSource === "undefined") return;
      const base = import.meta.env.VITE_API_URL ?? "";
      const url = `${base}/api/realtime/items:${encodeURIComponent(collection)}/subscribe`;
      const es = new EventSource(url, { withCredentials: true });
      es.addEventListener("open", () => setLive(true));
      es.addEventListener("message", bump);
      es.addEventListener("error", () => setLive(false));
      stop = () => {
        setLive(false);
        es.close();
      };
      if (disposed) stop();
    })();

    return () => {
      disposed = true;
      if (timer.current) clearTimeout(timer.current);
      stop?.();
      stop = null;
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

/**
 * Drag-to-reorder. The row lands where it was dropped IMMEDIATELY — a reorder
 * that waited on a round trip would show the operator's drag snapping back
 * before it took, which reads as a failure every time.
 *
 * `reorderVisible` does the optimistic half against the page's own positions
 * (nothing invented), and the invalidate afterwards picks up the real numbers —
 * including any renumbering the server's tie repair did on the way.
 */
export function useItemReorder(collection: string | null) {
  const qc = useQueryClient();
  const slug = collection || "posts";
  return useMutation({
    mutationFn: (vars: {
      field: string;
      id: string;
      anchorId: string;
      place: "before" | "after";
    }) =>
      itemsApi.reorder(
        slug,
        vars.field,
        vars.id,
        vars.place === "before" ? { before: vars.anchorId } : { after: vars.anchorId },
      ),
    onMutate: (vars) => {
      const snap = snapshotItems(qc, slug);
      patchItemRows(qc, slug, (rows) => {
        const view = rows.map((r) => ({
          id: r.id,
          position: numberOrNull((r as unknown as Record<string, unknown>)[vars.field]),
        }));
        const next = reorderVisible(view, vars.id, vars.anchorId, vars.place);
        if (!next) return rows;
        const byId = new Map(rows.map((r) => [r.id, r]));
        return next.map(
          (v) => ({ ...(byId.get(v.id) as Post), [vars.field]: v.position }) as Post,
        );
      });
      return { snap };
    },
    onError: (_e, _v, ctx) => ctx && restoreItems(qc, ctx.snap),
    onSettled: () => invalidateItems(qc, slug),
  });
}

/** A position as it comes off a row — a driver may hand it back as a string. */
const numberOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

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

/** Grid (spreadsheet) writes — N rows each with their own patch. A uniform
 *  patch (fill-down, single-value paste) collapses to one bulk-update call;
 *  mixed patches go through `/batch` update ops. Optimistic across every
 *  cached list variant; transport errors roll back, per-row failures are
 *  reported in the result and reconciled by the settled refetch. */
export function useItemsGridWrite(collection: string | null) {
  const qc = useQueryClient();
  const slug = collection || "posts";
  return useMutation({
    mutationFn: async (vars: { changes: Array<{ id: string; data: Record<string, unknown> }> }) => {
      const { changes } = vars;
      const firstData = JSON.stringify(changes[0]?.data ?? {});
      const uniform = changes.length > 1 && changes.every((ch) => JSON.stringify(ch.data) === firstData);
      if (uniform) {
        const res = await itemsApi.bulkUpdate(slug, changes.map((ch) => ch.id), changes[0]!.data);
        return { total: changes.length, failed: res.data.failed ?? res.data.results.filter((r) => !r.ok).length };
      }
      if (changes.length === 1) {
        const only = changes[0]!;
        await itemsApi.patch(slug, only.id, only.data);
        return { total: 1, failed: 0 };
      }
      const res = await itemsApi.batch(slug, changes.map((ch) => ({ op: "update" as const, id: ch.id, data: ch.data })));
      return { total: changes.length, failed: res.data.failed ?? 0 };
    },
    onMutate: (vars) => {
      const snap = snapshotItems(qc, slug);
      const now = nowIso();
      const byId = new Map(vars.changes.map((ch) => [ch.id, ch.data]));
      patchItemRows(qc, slug, (rows) =>
        rows.map((r) => (byId.has(r.id) ? ({ ...r, ...byId.get(r.id), updated_at: now } as Post) : r)),
      );
      return { snap };
    },
    onError: (_e, _v, ctx) => ctx && restoreItems(qc, ctx.snap),
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
