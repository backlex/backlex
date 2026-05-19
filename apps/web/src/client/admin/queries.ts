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
import { useQuery } from "@tanstack/react-query";
import { collectionsApi, metricsApi, rolesApi, tenantsApi } from "./api";

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
};

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
