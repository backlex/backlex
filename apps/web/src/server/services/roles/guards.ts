import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../../app";
import {
  getCachedTenantRoleNames,
  setCachedTenantRoleNames,
} from "../permissions-cache";
import { ensureDefaultTenant, type DbCtx } from "../seed";
import { tableFor } from "./tables";

export const requireTenant = (c: Context<AppBindings>): string => {
  const tenantId = c.get("auth")?.tenantId ?? null;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

export const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
};

/** Per-route admin gate — runs after `requireUser` so `auth.userId` is set. */
export const requireAdminMw: MiddlewareHandler<AppBindings> = async (c, next) => {
  requireAdmin(c.get("auth"));
  await next();
};

/** Reject workspace end-users (plane = "app"). Operator/control-plane actions —
 *  schema DDL, template apply, admin config — must never be reachable by a
 *  tenant's own customers, even though their bearer token passes `requireUser`
 *  and `tenantMiddleware` pins them to a workspace. Run before `requireAdminMw`
 *  so an app-plane caller is denied on the plane, not on the (empty) role set. */
export const requirePlatformMw: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  if (c.get("auth")?.plane !== "platform") {
    throw new AppError("FORBIDDEN", "Operator access required");
  }
  await next();
};

/** Is this identity the *instance* operator?
 *
 *  Deliberately NOT the workspace `admin` role. `POST /api/tenants` lets any
 *  authenticated user mint a workspace and grants them `admin` inside it, and
 *  `tenantMiddleware` recomputes `auth.roles` per active workspace — so that
 *  role name is self-serve and can never gate power that spans the whole
 *  database (raw SQL, cross-workspace session admin).
 *
 *  Operator = `admin` in the default/bootstrap workspace, where the first user
 *  is seeded (see `context.ts::onUserCreated`), plus `OWNER_EMAIL` when a
 *  provisioner pinned one. Existing single-workspace installs keep working
 *  untouched; a workspace created later grants nothing here.
 *
 *  API-key identities are never operators — a scoped machine key must not be
 *  able to escalate into the SQL console — and neither are app-plane
 *  end-users. */
export const isInstanceOperator = async (
  ctx: {
    db: unknown;
    dialect: "pg" | "sqlite";
    env: { OWNER_EMAIL?: string | undefined };
  },
  auth: {
    plane?: string;
    userId?: string | null;
    email?: string | null;
    apiKeyId?: string | null;
  },
): Promise<boolean> => {
  if (auth.plane !== "platform") return false;
  if (auth.apiKeyId) return false;
  if (!auth.userId) return false;
  const owner = ctx.env.OWNER_EMAIL?.trim().toLowerCase();
  if (owner && auth.email?.trim().toLowerCase() === owner) return true;
  // Cast matches the repo-wide dual-dialect convention — callers hand us a
  // structurally-loose ctx (see `assertTenantMember` below).
  const dbCtx = { db: ctx.db, dialect: ctx.dialect } as DbCtx;
  const defaultTenantId = await ensureDefaultTenant(dbCtx);
  // Same cache (and therefore the same invalidation on grant/revoke) that
  // tenantMiddleware uses for the active workspace.
  const cacheKey = {
    tenantId: defaultTenantId,
    userId: auth.userId,
    restrictRoleId: null,
  };
  const cached = getCachedTenantRoleNames(cacheKey);
  let names = cached;
  if (!names) {
    const t = tableFor(ctx.dialect);
    const rows = (await (ctx.db as any)
      .select({ name: t.roles.name })
      .from(t.userRoles)
      .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
      .where(
        and(
          eq(t.userRoles.userId, auth.userId),
          eq(t.roles.tenantId, defaultTenantId),
        ),
      )) as { name: string }[];
    names = rows.map((r) => r.name);
    setCachedTenantRoleNames(cacheKey, names);
  }
  return names.includes(SYSTEM_ROLES.admin);
};

/** Per-route instance-operator gate. Run after `requireUser`.
 *
 *  The message names the two ways back in on purpose: the only way to hold no
 *  operator at all is an instance whose default workspace was renamed or
 *  dropped by hand (nothing in the API mutates `tenants.slug`), and there
 *  `ensureDefaultTenant` would quietly mint an empty `default` that nobody
 *  admins. Setting `OWNER_EMAIL` recovers it without DB surgery. */
export const requireOperatorMw: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const ctx = c.get("ctx");
  if (!(await isInstanceOperator(ctx, c.get("auth")))) {
    throw new AppError(
      "FORBIDDEN",
      "Instance operator access required — sign in as an admin of the default workspace, or set OWNER_EMAIL to your address",
    );
  }
  await next();
};

/**
 * Refuse a WRITE aimed at a row that belongs to the deployment, not to a
 * workspace.
 *
 * Several tables carry `tenant_id NULL` for system-seeded rows that every
 * workspace can see — dashboards and saved panels are the ones this guards.
 * Reading them from any workspace is the point. Writing them is not: the row
 * a workspace admin edits is the row every OTHER workspace then renders, and
 * for a dashboard they can also mint an unauthenticated embed token for it.
 *
 * The doors that let this through all had the shape
 * `where(id = ?, or(tenant_id = ?, tenant_id IS NULL))`, with a comment saying
 * the admin role was already required. It was — and per
 * `db-admin.ts`/`services/roles/guards.ts` that role is self-serve, granted to
 * whoever creates a workspace, so it says nothing about instance-wide state.
 * Same substitution Faz 1 made on five route groups, applied per-ROW here
 * because the same endpoint legitimately serves workspace-owned rows.
 *
 * `null` row → no refusal: a missing row is the caller's own 404 to raise, and
 * answering FORBIDDEN here would tell them an id exists.
 */
export const assertWritableScope = async (
  ctx: {
    db: unknown;
    dialect: "pg" | "sqlite";
    env: { OWNER_EMAIL?: string | undefined };
  },
  auth: {
    plane?: string;
    userId?: string | null;
    email?: string | null;
    apiKeyId?: string | null;
  },
  row: { tenantId?: string | null } | null | undefined,
  what: string,
): Promise<void> => {
  if (!row) return;
  if (row.tenantId != null) return;
  if (await isInstanceOperator(ctx, auth)) return;
  throw new AppError(
    "FORBIDDEN",
    `${what} belongs to the whole deployment, not to this workspace — only the instance operator can change it`,
  );
};

/** Gate user-targeted routes on workspace membership: a tenant admin can
 *  only suspend / activate / revoke / remove users who belong to the
 *  active workspace, even though `users` and `sessions` are global. */
export const assertTenantMember = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
  userId: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.tenantMembers.id })
    .from(t.tenantMembers)
    .where(
      and(
        eq(t.tenantMembers.tenantId, tenantId),
        eq(t.tenantMembers.userId, userId),
      ),
    )
    .limit(1)) as { id: string }[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "User not in this workspace");
};
