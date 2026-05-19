import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { AppBindings } from "../../app";
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
