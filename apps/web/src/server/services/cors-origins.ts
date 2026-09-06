import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Env } from "../env";
import type { DbCtx } from "./seed";

/**
 * Which origins are allowed to make cross-origin, credentialled requests.
 *
 * On top of `APP_URL` (handled by the caller), an origin is allowed if it's
 * listed in `EXTRA_TRUSTED_ORIGINS` (deployment-wide) or it's the origin of a
 * redirect URL registered on *some* workspace's `auth_config.redirectUrls`.
 * So a customer who registers `https://app.acme.test/auth/callback` as a
 * redirect URL implicitly gets `https://app.acme.test` allowed for CORS too.
 *
 * The per-workspace set is cached at module scope and refreshed lazily (5 min
 * TTL, fire-and-forget) — the CORS middleware reads it synchronously.
 */

const normalizeOrigin = (s: string): string | null => {
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
};

/** Static, deployment-wide allow-list from the env var. */
export const envExtraOrigins = (env: Env): string[] =>
  (env.EXTRA_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeOrigin)
    .filter((o): o is string => o !== null);

/** Origins derived from a workspace's stored redirect URLs. */
export const redirectUrlOrigins = (urls: string[] | null | undefined): string[] => {
  const out = new Set<string>();
  for (const u of urls ?? []) {
    const o = normalizeOrigin(u);
    if (o) out.add(o);
  }
  return [...out];
};

const REFRESH_TTL_MS = 5 * 60 * 1000;
let cache = new Set<string>();
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;

/**
 * Is the redirect-URL source safe to use on THIS deployment?
 *
 * The cache is one module-scope set that answers for the whole deployment, and
 * it always was — `refresh` read `auth_config` with no `.where()` at all. On a
 * SINGLE-workspace instance that is exactly the documented feature: a customer
 * registers `https://app.acme.test/auth/callback` and their own app gets
 * credentialled CORS. On a MULTI-workspace instance it is a cross-tenant
 * boundary break: workspace B's admin writes one redirect URL and
 * `https://evil.example` receives `Access-Control-Allow-Origin` +
 * `Allow-Credentials: true` on every `/api/*` path — including workspace A's
 * data API, `/api/admin/*`, GraphQL and MCP.
 *
 * Keying the cache by workspace does not work, and that is worth writing down
 * rather than rediscovering: the CORS callback has to answer a PREFLIGHT, and a
 * preflight carries neither the `X-Backlex-Tenant` header's value nor cookies.
 * There is no workspace to key on at the moment the question is asked.
 *
 * So the source is used when the instance has at most one workspace, and
 * otherwise only when the operator says so — `CORS_TRUST_WORKSPACE_REDIRECTS=1`
 * for a deployment where every workspace is the same customer.
 * `EXTRA_TRUSTED_ORIGINS` is unaffected: that one IS a deployment-level
 * decision, made by the operator.
 */
const trustWorkspaceRedirects = (env: Env | undefined, tenantCount: number): boolean =>
  tenantCount <= 1 || env?.CORS_TRUST_WORKSPACE_REDIRECTS === "1";

let suppressedWarned = false;

const refresh = async (ctx: DbCtx, env?: Env): Promise<void> => {
  const t = ctx.dialect === "pg" ? pg.schema.authConfig : sqlite.schema.authConfig;
  const tenants = ctx.dialect === "pg" ? pg.schema.tenants : sqlite.schema.tenants;
  const [rows, tenantRows] = await Promise.all([
    (ctx.db as any).select({ redirectUrls: t.redirectUrls }).from(t) as Promise<
      Array<{ redirectUrls: string[] | null }>
    >,
    (ctx.db as any).select({ id: tenants.id }).from(tenants) as Promise<Array<{ id: string }>>,
  ]);
  const next = new Set<string>();
  if (trustWorkspaceRedirects(env, tenantRows.length)) {
    for (const r of rows) for (const o of redirectUrlOrigins(r.redirectUrls)) next.add(o);
  } else if (!suppressedWarned) {
    suppressedWarned = true;
    console.warn(
      "[cors] this deployment has more than one workspace, so redirect-URL origins are " +
        "NOT trusted for cross-origin credentialled requests — one workspace's setting " +
        "would apply to every other workspace's API. Set CORS_TRUST_WORKSPACE_REDIRECTS=1 " +
        "if every workspace here belongs to the same customer, or list the origins in " +
        "EXTRA_TRUSTED_ORIGINS.",
    );
  }
  cache = next;
  lastRefresh = Date.now();
};

/** Refresh the cached per-workspace origin set if it's stale. Fire-and-forget;
 *  concurrent calls share one in-flight refresh. */
export const refreshAllowedOriginsIfStale = (ctx: DbCtx, env?: Env): void => {
  if (refreshing) return;
  if (lastRefresh !== 0 && Date.now() - lastRefresh < REFRESH_TTL_MS) return;
  refreshing = refresh(ctx, env)
    .catch(() => {})
    .finally(() => {
      refreshing = null;
    });
};

/** Populate the cache up front (awaitable, errors swallowed). Called once per
 *  isolate during boot so the very first cross-origin request — even on a cold
 *  isolate — sees the workspace origin set instead of an empty cache. */
export const warmAllowedOrigins = async (ctx: DbCtx, env?: Env): Promise<void> => {
  try {
    await refresh(ctx, env);
  } catch {
    // table may not be migrated yet on a fresh DB — the lazy refresh in the
    // CORS middleware will pick it up later.
  }
};

/** True if `origin` is allowed cross-origin (env extras + cached workspace
 *  redirect-URL origins). `APP_URL` itself is the caller's responsibility. */
export const isWorkspaceAllowedOrigin = (origin: string, env: Env): boolean => {
  const n = normalizeOrigin(origin);
  if (!n) return false;
  return envExtraOrigins(env).includes(n) || cache.has(n);
};
