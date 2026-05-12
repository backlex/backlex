import { eq } from "drizzle-orm";
import {
  createTenantAuth,
  type TenantAuth,
  type OAuthProviderConfig,
} from "@workeros/auth";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { Env } from "../env";
import type { DbCtx } from "./seed";
import { decryptSecret } from "../lib/crypto";
import { loadAuthConfigRow } from "./auth-config";

/**
 * Resolve the workspace end-user auth instance for a given tenant slug — the
 * better-auth instance that powers `/api/t/<slug>/auth/*` for the customer's
 * application users.
 *
 * Each isolate keeps a small LRU of these instances so the per-request cost is
 * just a `Map.get`. The cache is invalidated by TTL (5 min) so config changes
 * picked up by another isolate eventually propagate; explicit invalidation
 * happens through {@link invalidateTenantAuth} when the admin app patches a
 * workspace's auth config.
 */

interface CachedEntry {
  tenantId: string;
  slug: string;
  auth: TenantAuth;
  builtAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 50;
const cache = new Map<string, CachedEntry>();

const touch = (key: string, entry: CachedEntry) => {
  cache.delete(key); // re-insert at the end → simple LRU on Map iteration order
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
};

const tenantsTableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.tenants : sqlite.schema.tenants;

export const findTenantBySlugOrId = async (
  ctx: DbCtx,
  key: string,
): Promise<{ id: string; slug: string } | null> => {
  const t = tenantsTableFor(ctx.dialect);
  const byId = await (ctx.db as any)
    .select({ id: t.id, slug: t.slug })
    .from(t)
    .where(eq(t.id, key))
    .limit(1);
  if (byId[0]) return byId[0] as { id: string; slug: string };
  const bySlug = await (ctx.db as any)
    .select({ id: t.id, slug: t.slug })
    .from(t)
    .where(eq(t.slug, key))
    .limit(1);
  return (bySlug[0] as { id: string; slug: string } | undefined) ?? null;
};

const providerEntry = (
  providers: Record<string, unknown> | null | undefined,
  key: string,
): { enabled?: unknown; clientId?: unknown; clientSecretEnc?: unknown } => {
  const v = (providers ?? {})[key];
  return v && typeof v === "object"
    ? (v as { enabled?: unknown; clientId?: unknown; clientSecretEnc?: unknown })
    : {};
};

/**
 * Build (or fetch from cache) the better-auth instance for a workspace.
 *
 * Provider configuration is sourced from the workspace's stored `auth_config`
 * row when present:
 *   - an OAuth provider is wired iff it's not disabled AND has a `clientId`
 *     plus a decryptable `clientSecretEnc`; otherwise it falls back to the
 *     env-level OAuth credentials (unless the stored config explicitly
 *     disables it);
 *   - email+password is enabled unless `providers.email.enabled === false`.
 *
 * Per-workspace magic-link / email-otp and a config-driven session lifetime
 * are not wired yet (would need an email adapter handed through here).
 */
export const getTenantAuth = async (
  ctx: DbCtx,
  env: Env,
  tenant: { id: string; slug: string },
): Promise<TenantAuth> => {
  const existing = cache.get(tenant.id);
  if (existing && Date.now() - existing.builtAt < CACHE_TTL_MS && existing.slug === tenant.slug) {
    touch(tenant.id, existing);
    return existing.auth;
  }

  const storedRow = await loadAuthConfigRow(ctx, tenant.id);
  const stored = (storedRow?.providers ?? null) as Record<string, unknown> | null;

  const social: { google?: OAuthProviderConfig; github?: OAuthProviderConfig } = {};
  for (const [key, envId, envSecret] of [
    ["google", env.OAUTH_GOOGLE_CLIENT_ID, env.OAUTH_GOOGLE_CLIENT_SECRET],
    ["github", env.OAUTH_GITHUB_CLIENT_ID, env.OAUTH_GITHUB_CLIENT_SECRET],
  ] as const) {
    const cfg = providerEntry(stored, key);
    if (cfg.enabled === false) continue; // workspace turned this provider off
    // Prefer the workspace's own credentials.
    if (typeof cfg.clientId === "string" && cfg.clientId.trim() && typeof cfg.clientSecretEnc === "string") {
      const secret = await decryptSecret(cfg.clientSecretEnc, env.AUTH_SECRET);
      if (secret) {
        social[key] = { clientId: cfg.clientId.trim(), clientSecret: secret };
        continue;
      }
    }
    // Fall back to env-level OAuth.
    if (envId && envSecret) social[key] = { clientId: envId, clientSecret: envSecret };
  }

  const emailEnabled = providerEntry(stored, "email").enabled !== false;

  const pluginList = (env.AUTH_PLUGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(
      (p): p is "magic-link" | "email-otp" =>
        p === "magic-link" || p === "email-otp",
    );

  const auth = createTenantAuth(ctx.db, ctx.dialect, {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    appURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    emailAndPasswordEnabled: emailEnabled,
    socialProviders: Object.keys(social).length > 0 ? social : undefined,
    plugins: pluginList,
  });

  const entry: CachedEntry = {
    tenantId: tenant.id,
    slug: tenant.slug,
    auth,
    builtAt: Date.now(),
  };
  touch(tenant.id, entry);
  return auth;
};

/** Drop the cached instance for a workspace — call this from the admin route
 *  that PATCHes `auth_config` so the next request rebuilds from the new state. */
export const invalidateTenantAuth = (tenantId: string): void => {
  cache.delete(tenantId);
};
