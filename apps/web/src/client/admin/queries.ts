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
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  activityApi,
  advisorApi,
  collectionsApi,
  commentsApi,
  meApi,
  metricsApi,
  notificationsApi,
  rolesApi,
  sharedLinksApi,
  tenantsApi,
} from "./api";

export const queryKeys = {
  tenants: () => ["tenants"] as const,
  tenantMembers: (tenantId: string | null) => ["tenants", tenantId, "members"] as const,
  /** Keyed by the archived flag — active and archived are distinct cache
   *  entries so toggling the Collections-index view doesn't clobber the
   *  other list. `invalidateQueries({ queryKey: ["collections"] })` still
   *  matches both because the prefix is shared. */
  collections: (includeArchived = false) => ["collections", { includeArchived }] as const,
  metricsOverview: (range: string) => ["metrics", "overview", range] as const,
  roles: () => ["roles"] as const,
  me: () => ["me"] as const,
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
  /** Activity log rows — the unified Logs page's data source. Keyed by the
   *  server-side filters (`from`, `action`, `pageSize`) so changing the time
   *  window or the action filter is a distinct cache entry; `offset` is the
   *  per-page cursor and lives in `useInfiniteQuery`'s page params, not here. */
  activity: (filters: ActivityFilters) => ["activity", filters] as const,
};

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
