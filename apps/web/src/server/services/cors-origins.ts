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

const refresh = async (ctx: DbCtx): Promise<void> => {
  const t = ctx.dialect === "pg" ? pg.schema.authConfig : sqlite.schema.authConfig;
  const rows = (await (ctx.db as any)
    .select({ redirectUrls: t.redirectUrls })
    .from(t)) as Array<{ redirectUrls: string[] | null }>;
  const next = new Set<string>();
  for (const r of rows) for (const o of redirectUrlOrigins(r.redirectUrls)) next.add(o);
  cache = next;
  lastRefresh = Date.now();
};

/** Refresh the cached per-workspace origin set if it's stale. Fire-and-forget;
 *  concurrent calls share one in-flight refresh. */
export const refreshAllowedOriginsIfStale = (ctx: DbCtx): void => {
  if (refreshing) return;
  if (lastRefresh !== 0 && Date.now() - lastRefresh < REFRESH_TTL_MS) return;
  refreshing = refresh(ctx)
    .catch(() => {})
    .finally(() => {
      refreshing = null;
    });
};

/** Populate the cache up front (awaitable, errors swallowed). Called once per
 *  isolate during boot so the very first cross-origin request — even on a cold
 *  isolate — sees the workspace origin set instead of an empty cache. */
export const warmAllowedOrigins = async (ctx: DbCtx): Promise<void> => {
  try {
    await refresh(ctx);
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
