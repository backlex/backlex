import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppBindings } from "../app";
import {
  getCachedMembership,
  getCachedTenantRoleNames,
  setCachedMembership,
  setCachedTenantRoleNames,
} from "../services/permissions-cache";
import { ensureDefaultTenant } from "../services/seed";
import { loadUnfilteredRoleNames } from "./session";

/** Loose UUID v4-ish shape check — strict enough to avoid false positives on
 *  slugs (which can't contain `-` in groups of 8-4-4-4-12 hex). When a cookie
 *  value matches we skip the dedicated tenant lookup and rely on the membership
 *  check below to validate that the id really exists for this user. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TENANT_COOKIE = "backlex-tenant";
export const TENANT_HEADER = "x-backlex-tenant";

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        tenants: pg.schema.tenants,
        members: pg.schema.tenantMembers,
        users: pg.schema.users,
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
      }
    : {
        tenants: sqlite.schema.tenants,
        members: sqlite.schema.tenantMembers,
        users: sqlite.schema.users,
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
      };

/** Roles the user holds *within this tenant*. Used by tenantMiddleware to
 *  rewrite auth.roles after the active tenant is known — sessionMiddleware
 *  can't filter by tenant because resolution hasn't happened yet there.
 *
 *  `restrictRoleId` (set when the request authenticated with a role-scoped
 *  API key) narrows the result to that single role — and only while the
 *  owner still holds it, so a scoped key can never out-live the grant. */
const loadTenantRoleNames = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
  restrictRoleId: string | null,
): Promise<string[]> => {
  // Hot path: served from the per-isolate cache, invalidated on role grant/
  // revoke (invalidateUserRoles), role-def change (invalidateTenantRoles), and
  // membership change (invalidateTenantMembership). See services/permissions-cache.
  // Copy on hit so a caller that mutates auth.roles can't corrupt the entry.
  const cacheKey = { tenantId, userId, restrictRoleId };
  const cached = getCachedTenantRoleNames(cacheKey);
  if (cached) return [...cached];
  const t = tablesFor(dialect);
  const rows = (await (db as any)
    .select({ name: t.roles.name })
    .from(t.userRoles)
    .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
    .where(
      restrictRoleId
        ? and(
            eq(t.userRoles.userId, userId),
            eq(t.roles.tenantId, tenantId),
            eq(t.roles.id, restrictRoleId),
          )
        : and(eq(t.userRoles.userId, userId), eq(t.roles.tenantId, tenantId)),
    )) as { name: string }[];
  const names = rows.map((r) => r.name);
  setCachedTenantRoleNames(cacheKey, names);
  return names;
};

const tenantBySlugOrId = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  key: string,
): Promise<string | null> => {
  const t = tablesFor(dialect).tenants;
  // One SELECT against `id = ? OR slug = ?` is cheaper than the two sequential
  // round-trips the previous version did, and the table is small (rows.length
  // ≤ 1 since both id and slug are unique).
  const rows = (await (db as any)
    .select({ id: t.id })
    .from(t)
    .where(or(eq(t.id, key), eq(t.slug, key)))
    .limit(1)) as { id: string }[];
  return rows[0]?.id ?? null;
};

const isMember = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
): Promise<boolean> => {
  // Existence-only check (status changes like suspend don't flip it), so it's
  // safe to cache per isolate; invalidated on membership add/remove via
  // invalidateTenantMembership.
  const cacheKey = { tenantId, userId };
  const cached = getCachedMembership(cacheKey);
  if (cached !== undefined) return cached;
  const m = tablesFor(dialect).members;
  const rows = (await (db as any)
    .select({ id: m.id })
    .from(m)
    .where(and(eq(m.tenantId, tenantId), eq(m.userId, userId)))
    .limit(1)) as { id: string }[];
  const result = rows.length > 0;
  setCachedMembership(cacheKey, result);
  return result;
};

/** Lightweight existence check for a tenant id. Used only by the cross-tenant
 *  admin shortcut to keep the UUID-cookie bypass from leaking a syntactically-
 *  valid but non-existent id into `auth.tenantId` for the rest of the request. */
const tenantExists = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
): Promise<boolean> => {
  const t = tablesFor(dialect).tenants;
  const rows = (await (db as any)
    .select({ id: t.id })
    .from(t)
    .where(eq(t.id, tenantId))
    .limit(1)) as { id: string }[];
  return rows.length > 0;
};

const firstUserTenant = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  userId: string,
): Promise<string | null> => {
  const m = tablesFor(dialect).members;
  const rows = (await (db as any)
    .select({ tenantId: m.tenantId })
    .from(m)
    .where(eq(m.userId, userId))
    .limit(1)) as { tenantId: string }[];
  return rows[0]?.tenantId ?? null;
};

const persistActive = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  userId: string,
  tenantId: string,
): Promise<void> => {
  const u = tablesFor(dialect).users;
  await (db as any)
    .update(u)
    .set({ activeTenantId: tenantId, updatedAt: new Date() })
    .where(eq(u.id, userId));
};

/** Touch tenant_members.last_seen_at on every authenticated request so the
 *  Members panel can show "active 2m ago" without joining sessions. */
const touchMember = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
): Promise<void> => {
  const m = tablesFor(dialect).members;
  try {
    await (db as any)
      .update(m)
      .set({ lastSeenAt: dialect === "pg" ? new Date() : Date.now() })
      .where(and(eq(m.tenantId, tenantId), eq(m.userId, userId)));
  } catch {
    // If the column doesn't exist yet (pre-migration deploy) just skip —
    // the next deploy applies the migration and this resumes working.
  }
};

/**
 * Resolve the active tenant for the request:
 *   1. `X-Backlex-Tenant` header (slug or id)
 *   2. `backlex-tenant` cookie
 *   3. user.activeTenantId
 *   4. first tenant the user belongs to
 *   5. default tenant (created on demand)
 *
 * Sets `auth.tenantId` so it propagates into the permission DSL via $tenant.id
 * and is available to every route via `c.get("auth").tenantId`.
 */
export const tenantMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const db = ctx.db;
  const dialect = ctx.dialect;

  let tenantId: string | null = null;

  // Resolve the requested tenant id. UUIDs are accepted *as-is* — the membership
  // check below catches bogus ids cheaply, so we skip the dedicated lookup. Non-
  // UUID values (slugs) still need the SELECT to map slug → id.
  const resolveTenantKey = async (key: string): Promise<string | null> => {
    if (UUID_RE.test(key)) return key;
    return tenantBySlugOrId(db, dialect, key);
  };

  const headerKey = c.req.header(TENANT_HEADER);
  if (headerKey) {
    tenantId = await resolveTenantKey(headerKey);
  }
  // API-key requests pin to the key's home tenant unless the caller sent an
  // explicit override header. Cookie/user-pref are irrelevant here — the
  // request might be a CI job with no session at all.
  if (!tenantId && auth.apiKeyTenantId) {
    tenantId = auth.apiKeyTenantId;
  }
  // App-plane sessions are bound to the workspace that issued them; ignore
  // any header/cookie overrides so a customer's frontend can't accidentally
  // walk into another workspace's data.
  if (auth.plane === "app" && auth.appSessionTenantId) {
    tenantId = auth.appSessionTenantId;
  }
  if (!tenantId) {
    const cookieKey = getCookie(c, TENANT_COOKIE);
    if (cookieKey) tenantId = await resolveTenantKey(cookieKey);
  }
  // Control-plane users: confirm the requested tenant is one they belong to
  // (admins bypass). App-plane users are bound to the workspace their session
  // was issued for — that's authoritative, and they have no `tenant_members`
  // row, so the membership check (and the `tenant_members`/`users` fallbacks
  // and writes below) don't apply to them.
  //
  // Hot path: run the membership check and the tenant-scoped role load in
  // parallel. If membership fails we fall back to a lazy global-admin lookup
  // (the only reason we'd ever need the unfiltered role union) — this keeps
  // the lookup off the request path for every member-of-tenant call, which
  // is by far the common case.
  let tenantRoles: string[] = [];
  // Whether to persist this tenant choice in the backlex-tenant cookie.
  // Default true — the common case is a member operating on a workspace they
  // belong to. Flipped to false when we're letting a cross-tenant admin
  // *view* another workspace via the super-admin shortcut: their actual home
  // workspace should not be silently overwritten by a one-shot visit.
  let pinTenantCookie = true;
  if (auth.userId && auth.plane !== "app") {
    if (tenantId) {
      const [member, scopedRoles] = await Promise.all([
        isMember(db, dialect, tenantId, auth.userId),
        loadTenantRoleNames(
          db,
          dialect,
          tenantId,
          auth.userId,
          auth.apiKeyRoleId ?? null,
        ),
      ]);
      if (member) {
        tenantRoles = scopedRoles;
      } else {
        // Membership failed — last chance is a cross-tenant super-admin.
        // We also confirm the tenant actually exists so a forged UUID can't
        // ride the UUID-bypass into `auth.tenantId` for the rest of the
        // request (the resolver would still deny on permissions, but audit
        // logs / route handlers that trust `auth.tenantId` would see a bogus
        // id). For non-admins membership already failed → tenantId nulled.
        const [globalRoles, exists] = await Promise.all([
          loadUnfilteredRoleNames(
            { db, dialect },
            auth.userId,
            auth.apiKeyRoleId ?? null,
          ),
          tenantExists(db, dialect, tenantId),
        ]);
        if (globalRoles.includes("admin") && exists) {
          tenantRoles = scopedRoles; // admin keeps tenant-scoped role names
          // Cross-tenant admin shortcut: viewing only. Don't persist the
          // visit so the next request without a header drops back to the
          // admin's own workspace (and clear any leaked cookie below).
          pinTenantCookie = false;
        } else {
          tenantId = null;
        }
      }
    }
    if (!tenantId) {
      tenantId = await firstUserTenant(db, dialect, auth.userId);
      if (tenantId) {
        tenantRoles = await loadTenantRoleNames(
          db,
          dialect,
          tenantId,
          auth.userId,
          auth.apiKeyRoleId ?? null,
        );
      }
    }
  }
  // For app-plane there's no fallback workspace — if the session's tenant
  // didn't resolve, leave it null and let permission resolution deny.
  if (!tenantId && auth.plane !== "app") {
    tenantId = await ensureDefaultTenant({ db, dialect });
  }

  // App-plane identities don't participate in control-plane RBAC, so
  // `auth.roles` stays empty for them — the data-plane permission resolver
  // loads their workspace roles separately.
  if (auth.userId && auth.plane !== "app" && tenantId) {
    // Best-effort persistence; ignore failures.
    void persistActive(db, dialect, auth.userId, tenantId).catch(() => {});
    void touchMember(db, dialect, tenantId, auth.userId).catch(() => {});
  }

  c.set("auth", { ...auth, roles: tenantRoles, tenantId });
  // Stamp the request start so route handlers can pass duration_ms to
  // recordActivity without each one having to remember to capture Date.now().
  // Use Hono's typed `set` — assigning to `c.var` directly hits a Proxy that
  // doesn't persist arbitrary keys.
  (c as unknown as { set: (k: string, v: unknown) => void }).set("__startedAt", Date.now());
  await next();

  // Cookie has to be appended *after* next() — better-auth (and any other
  // downstream handler that returns a fresh Response) replaces the staged
  // headers, so a setCookie call before next() gets dropped along with the
  // session cookie. Setting it here merges into the final response.
  //
  // Re-read auth.tenantId after next() so handlers like /api/tenants/switch
  // (which mutate auth to point at the new workspace) win — otherwise the
  // closed-over `tenantId` from the pre-next phase clobbers their cookie.
  const finalTenantId =
    (c.get("auth")?.tenantId as string | null | undefined) ?? tenantId;
  if (finalTenantId && pinTenantCookie) {
    setCookie(c, TENANT_COOKIE, finalTenantId, {
      httpOnly: false,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  } else if (!pinTenantCookie) {
    // Cross-tenant admin pass-through: actively clear any leaked cookie so
    // a previous header-driven visit doesn't keep silently routing every
    // subsequent request through the foreign workspace.
    deleteCookie(c, TENANT_COOKIE, { path: "/" });
  }
};
