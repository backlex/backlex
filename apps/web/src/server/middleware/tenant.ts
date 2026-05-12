import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { ensureDefaultTenant } from "../services/seed";

export const TENANT_COOKIE = "workeros-tenant";
export const TENANT_HEADER = "x-workeros-tenant";

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
 *  can't filter by tenant because resolution hasn't happened yet there. */
const loadTenantRoleNames = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
): Promise<string[]> => {
  const t = tablesFor(dialect);
  const rows = (await (db as any)
    .select({ name: t.roles.name })
    .from(t.userRoles)
    .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
    .where(and(eq(t.userRoles.userId, userId), eq(t.roles.tenantId, tenantId)))) as { name: string }[];
  return rows.map((r) => r.name);
};

const tenantBySlugOrId = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  key: string,
): Promise<string | null> => {
  const t = tablesFor(dialect).tenants;
  const rows = (await (db as any)
    .select({ id: t.id })
    .from(t)
    .where(eq(t.id, key))
    .limit(1)) as { id: string }[];
  if (rows[0]) return rows[0].id;
  const rows2 = (await (db as any)
    .select({ id: t.id })
    .from(t)
    .where(eq(t.slug, key))
    .limit(1)) as { id: string }[];
  return rows2[0]?.id ?? null;
};

const isMember = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
): Promise<boolean> => {
  const m = tablesFor(dialect).members;
  const rows = (await (db as any)
    .select({ id: m.id })
    .from(m)
    .where(and(eq(m.tenantId, tenantId), eq(m.userId, userId)))
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
 *   1. `X-Workeros-Tenant` header (slug or id)
 *   2. `workeros-tenant` cookie
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

  const headerKey = c.req.header(TENANT_HEADER);
  if (headerKey) {
    tenantId = await tenantBySlugOrId(db, dialect, headerKey);
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
    if (cookieKey) tenantId = await tenantBySlugOrId(db, dialect, cookieKey);
  }
  // Control-plane users: confirm the requested tenant is one they belong to
  // (admins bypass). App-plane users are bound to the workspace their session
  // was issued for — that's authoritative, and they have no `tenant_members`
  // row, so the membership check (and the `tenant_members`/`users` fallbacks
  // and writes below) don't apply to them.
  if (auth.userId && auth.plane !== "app") {
    if (tenantId) {
      const allow = auth.roles.includes("admin") ||
        (await isMember(db, dialect, tenantId, auth.userId));
      if (!allow) tenantId = null;
    }
    if (!tenantId) {
      tenantId = await firstUserTenant(db, dialect, auth.userId);
    }
  }
  // For app-plane there's no fallback workspace — if the session's tenant
  // didn't resolve, leave it null and let permission resolution deny.
  if (!tenantId && auth.plane !== "app") {
    tenantId = await ensureDefaultTenant({ db, dialect });
  }

  // Re-scope auth.roles to roles the user actually holds *in this tenant*.
  // sessionMiddleware loaded an unfiltered union earlier (it doesn't know
  // the tenant yet); we replace it here so requireAdmin and friends evaluate
  // against the active workspace. App-plane identities don't participate in
  // control-plane RBAC, so `auth.roles` stays empty for them — the data-plane
  // permission resolver loads their workspace roles separately.
  let tenantRoles = auth.roles;
  if (auth.userId && auth.plane !== "app" && tenantId) {
    tenantRoles = await loadTenantRoleNames(db, dialect, tenantId, auth.userId);
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
  if (finalTenantId)
    setCookie(c, TENANT_COOKIE, finalTenantId, {
      httpOnly: false,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
  });
};
